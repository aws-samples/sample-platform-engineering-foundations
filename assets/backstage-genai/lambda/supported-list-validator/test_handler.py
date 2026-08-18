# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Part 1: CFN structural check - the validator resources must exist
#   unconditionally. A standalone deploy uses the default Environment, so
#   gating them on an environment would drop the Bedrock model validation
#   exactly where it is most useful: an account whose model access nobody
#   pre-checked.
# Part 2: Hypothesis PBT for the 14-day check - for any string matching
#   ^anthropic\.claude.* (length 1..256), the handler returns SUCCESS iff the
#   model is present on the (mocked, machine-readable) supported list with
#   days_on_list >= MIN_DAYS.
# Part 3: the graceful-degradation path - when the published list cannot be
#   parsed, the handler reports SUCCESS with SupportedListChecked=false
#   instead of taking the stack down for a third-party rendering choice.

import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml
from hypothesis import HealthCheck, given, settings, strategies as st

HANDLER_DIR = Path(__file__).parent
sys.path.insert(0, str(HANDLER_DIR))
import handler  # noqa: E402

CLAUDE_PREFIX_RE = re.compile(r'^anthropic\.claude.*$')
PREFIX = 'anthropic.claude'


def claude_model_id_strategy():
    """Any non-empty string matching ^anthropic\\.claude.*$, length 16..256."""
    return st.text(
        alphabet=st.characters(min_codepoint=33, max_codepoint=126),
        min_size=0,
        max_size=256 - len(PREFIX),
    ).map(lambda s: (PREFIX + s)[:256])


# Filler rows carry no digits and no model id, so they can never be mistaken
# for an added-date line. They exist only to push the page past the 4 KB floor
# the handler uses to reject JavaScript stubs.
_FILLER_ROW = '<tr><td>filler row, no identifier and no date here</td></tr>\n'


def _readable_page(rows: str) -> str:
    """Wraps rows in a table large enough to look like a rendered page."""
    return (
        '<html><body><table>\n' + rows + _FILLER_ROW * 120 +
        '</table></body></html>\n'
    )


# --- Part 1: CFN structural check (single example, not a property) ---

def test_cfn_template_runs_validator_in_every_environment():
    """The validator's CFN resources MUST exist unconditionally.

    Gating them on an environment would silently drop the Bedrock model
    validation on a standalone deploy, which is precisely the account where
    nobody pre-checked model access."""
    cfn_path = (
        HANDLER_DIR.parent.parent.parent.parent
        / 'infrastructure' / 'cloudformation'
        / 'psp-workshop-eks.yaml'
    )
    assert cfn_path.is_file(), f'CFN template not found at {cfn_path}'

    text = cfn_path.read_text()

    # CFN-tolerant YAML loader: !Sub, !Ref, !GetAtt etc. become plain scalars.
    class CfnLoader(yaml.SafeLoader):
        pass

    def _cfn_multi(loader, tag_suffix, node):
        if isinstance(node, yaml.ScalarNode):
            return loader.construct_scalar(node)
        if isinstance(node, yaml.SequenceNode):
            return loader.construct_sequence(node)
        return loader.construct_mapping(node)

    CfnLoader.add_multi_constructor('!', _cfn_multi)

    doc = yaml.load(text, Loader=CfnLoader)
    resources = doc.get('Resources', {})

    expected = {
        'SupportedListValidatorRole',
        'SupportedListValidatorLogGroup',
        'SupportedListValidatorFunction',
        'SupportedListValidator',
    }
    for name in expected:
        assert name in resources, f'Resource missing from template: {name}'
        cond = resources[name].get('Condition')
        assert cond is None, (
            f'{name} carries Condition={cond!r}; the validator must run in '
            f'every environment, including a standalone deploy'
        )


# --- Part 2: hypothesis PBT for the 14-day check ---

@given(
    model_id=claude_model_id_strategy(),
    days_offset=st.integers(min_value=-30, max_value=365),
)
@settings(
    suppress_health_check=[HealthCheck.function_scoped_fixture],
    max_examples=100,
    deadline=None,
)
def test_handler_enforces_14_day_window(model_id, days_offset):
    """For any claude model_id and any added-date offset, the handler returns
    SUCCESS iff the model is on the supported list AND days_on_list >= 14.

    Encoding:
      days_offset <  0  -> model NOT on the supported list -> FAILED
      days_offset >= 0  -> model on the list, with days_offset days elapsed

    The mocked page is deliberately machine-readable (a real table, over the
    4 KB floor the handler uses to tell a rendered page from a JavaScript
    stub), because that is the only shape in which the 14-day rule is
    blocking. The unreadable shape is covered separately in Part 3.
    """
    # Sanity: every generated model_id satisfies the spec regex.
    assert CLAUDE_PREFIX_RE.match(model_id), model_id
    assert 1 <= len(model_id) <= 256

    now = datetime.now(timezone.utc)

    if days_offset < 0:
        row = '<tr><td>no model on this page</td></tr>\n'
        added_date = None
        on_list = False
    else:
        added_date = now - timedelta(days=days_offset)
        # Put the date FIRST on the line so the first \d{4}-\d{2}-\d{2}
        # match is the real added-date - guards against model_ids that
        # happen to contain digit-hyphen patterns.
        row = f'<tr><td>{added_date.strftime("%Y-%m-%d")} added: {model_id}</td></tr>\n'
        on_list = True
    synthetic_html = _readable_page(row)

    sent = {}

    def mock_cfn_send(event, status, reason, data=None):
        sent['status'] = status
        sent['reason'] = reason
        sent['data'] = data

    def mock_fetch():
        return synthetic_html

    def mock_check_access(region, m):
        return True, None

    event = {
        'RequestType': 'Create',
        'StackId': 'arn:aws:cloudformation:us-east-1:000000000000:stack/test/1',
        'RequestId': 'req-1',
        'LogicalResourceId': 'SupportedListValidator',
        'PhysicalResourceId': 'phys-1',
        'ResponseURL': 'https://example.invalid/response',
        'ResourceProperties': {
            'ModelId': model_id,
            'Region': 'us-east-1',
            'MinDaysOnList': 14,
        },
    }

    with patch.object(handler, '_cfn_send', side_effect=mock_cfn_send), \
         patch.object(handler, '_fetch_supported_models_table', side_effect=mock_fetch), \
         patch.object(handler, '_check_bedrock_region_access', side_effect=mock_check_access):
        handler.handler(event, None)

    assert 'status' in sent, 'handler did not call _cfn_send'

    if not on_list:
        assert sent['status'] == 'FAILED', sent
        assert 'not present on the supported list' in sent['reason']
    else:
        # days_on_list at handler-eval time is at least `days_offset`
        # (handler runs strictly after now, so the delta is >= days_offset).
        if days_offset >= 14:
            assert sent['status'] == 'SUCCESS', sent
        else:
            assert sent['status'] == 'FAILED', sent
            assert 'has been on the supported list for' in sent['reason']
            assert 'minimum required is 14 days' in sent['reason']


# --- Part 3: graceful degradation when the published list is unreadable ---

@pytest.mark.parametrize('page', [
    'You need to enable JavaScript to run this app.',   # JavaScript stub
    '<table><tr><td>too short to be a rendered page</td></tr></table>',
])
def test_handler_degrades_when_list_is_unreadable(page):
    """An unreadable list must NOT fail the stack.

    The reference page is client-side rendered, so the HTML carries no table.
    Model access in the region has already been confirmed at that point, and
    an operator cannot act on a third-party rendering choice, so the handler
    reports SUCCESS with SupportedListChecked=false and leaves the 14-day rule
    to a human."""
    sent = {}

    event = {
        'RequestType': 'Create',
        'StackId': 'arn:aws:cloudformation:us-east-1:000000000000:stack/test/1',
        'RequestId': 'req-1',
        'LogicalResourceId': 'SupportedListValidator',
        'PhysicalResourceId': 'phys-1',
        'ResponseURL': 'https://example.invalid/response',
        'ResourceProperties': {
            'ModelId': 'anthropic.claude-haiku-4-5-20251001-v1:0',
            'Region': 'us-east-1',
            'MinDaysOnList': 14,
        },
    }

    with patch.object(handler, '_cfn_send',
                      side_effect=lambda e, s, r, data=None: sent.update(
                          status=s, reason=r, data=data)), \
         patch.object(handler, '_fetch_supported_models_table',
                      side_effect=lambda: page), \
         patch.object(handler, '_check_bedrock_region_access',
                      side_effect=lambda region, m: (True, None)):
        handler.handler(event, None)

    assert sent['status'] == 'SUCCESS', sent
    assert sent['data'] == {'SupportedListChecked': 'false'}, sent
    assert 'manually verify' in sent['reason'] or 'manual verification' in sent['reason']
