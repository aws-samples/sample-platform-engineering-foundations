# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Pre-warm retry state machine respects attempt cap, backoff,
# and two-success rule.
# Pre-warm structured log shape.

import json
import os
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
from hypothesis import given, strategies as st, settings, HealthCheck

HANDLER_DIR = Path(__file__).parent
sys.path.insert(0, str(HANDLER_DIR))
os.environ.setdefault('BEDROCK_MODEL_ID', 'us.anthropic.claude-haiku-4-5-20251001-v1:0')
os.environ.setdefault('BEDROCK_REGION', 'us-east-1')
import handler  # noqa: E402


outcome_strategy = st.sampled_from(['success', 'marketplace_denied', 'other_error', 'timeout'])


@given(trace=st.lists(outcome_strategy, min_size=1, max_size=8))
@settings(
    suppress_health_check=[HealthCheck.function_scoped_fixture],
    max_examples=100,
    deadline=None,
)
def test_attempt_cap_and_two_success_rule(trace):
    """Drive the handler with a configurable trace of outcomes. Assert:
       - at most 4 attempts per phase (and 2 phases max -> 8 invocations)
       - backoff between consecutive attempts is exactly BACKOFF_SECONDS
       - SUCCESS reported iff phase 1 ends in success AND phase 2 ends in success
       - on FAILED, the response Data carries the last-failing outcome
    """
    invocation_log = []
    sleep_calls = []

    # Build a side_effect that yields the next outcome from `trace`. When the
    # trace is exhausted, default to 'other_error' (perpetually-failing acct).
    trace_iter = iter(trace)

    def fake_invoke_once(client, model_id):
        try:
            outcome = next(trace_iter)
        except StopIteration:
            outcome = 'other_error'
        invocation_log.append(outcome)
        if outcome == 'success':
            return MagicMock()
        if outcome == 'marketplace_denied':
            raise handler.botocore.exceptions.ClientError(
                error_response={
                    'Error': {
                        'Code': 'AccessDeniedException',
                        'Message': 'aws-marketplace:Subscribe denied',
                    }
                },
                operation_name='InvokeModel',
            )
        if outcome == 'timeout':
            raise handler.botocore.exceptions.ReadTimeoutError(
                endpoint_url='https://bedrock-runtime.us-east-1.amazonaws.com'
            )
        # other_error
        raise RuntimeError('other_error stub')

    sent = {}

    def fake_cfn_send(event, status, reason, data=None):
        sent['status'] = status
        sent['reason'] = reason
        sent['data'] = data or {}

    def fake_sleep(seconds):
        sleep_calls.append(seconds)

    event = {
        'RequestType': 'Create',
        'StackId': 'arn:aws:cloudformation:us-east-1:000000000000:stack/test/1',
        'RequestId': 'req-1',
        'LogicalResourceId': 'BedrockPrewarm',
        'PhysicalResourceId': 'phys-1',
        'ResponseURL': 'https://example.invalid/response',
    }

    with patch.object(handler, '_invoke_once', side_effect=fake_invoke_once), \
         patch.object(handler, '_cfn_send', side_effect=fake_cfn_send), \
         patch('time.sleep', side_effect=fake_sleep):
        handler.handler(event, None)

    # ----- Attempt cap -----
    # Two phases of up to MAX_ATTEMPTS each => at most 8 total invocations.
    assert len(invocation_log) <= 2 * handler.MAX_ATTEMPTS, (
        f'invocations={len(invocation_log)} exceeds cap of '
        f'{2 * handler.MAX_ATTEMPTS}'
    )

    # ----- Backoff -----
    # Every sleep MUST be exactly BACKOFF_SECONDS.
    for s in sleep_calls:
        assert s == handler.BACKOFF_SECONDS, (
            f'sleep={s} != BACKOFF_SECONDS={handler.BACKOFF_SECONDS}'
        )

    # ----- Two-consecutive-success rule -----
    # Reconstruct phase 1 boundary the same way the handler does: read forward
    # until 'success' OR MAX_ATTEMPTS failures.
    phase1_end = None
    for i, o in enumerate(invocation_log):
        if o == 'success':
            phase1_end = i + 1
            break
        if i == handler.MAX_ATTEMPTS - 1:
            phase1_end = i + 1
            break
    assert phase1_end is not None
    phase1 = invocation_log[:phase1_end]
    phase2 = invocation_log[phase1_end:]

    phase1_succeeded = phase1[-1] == 'success'
    phase2_succeeded = len(phase2) > 0 and phase2[-1] == 'success'

    if sent['status'] == 'SUCCESS':
        # Success iff BOTH phases ended in success.
        assert phase1_succeeded and phase2_succeeded, (
            f'SUCCESS reported but phase1_succeeded={phase1_succeeded}, '
            f'phase2_succeeded={phase2_succeeded}, log={invocation_log}'
        )
        # The Outcome field must reflect success.
        assert sent['data'].get('Outcome') == handler.OUTCOME_SUCCESS
    else:
        assert sent['status'] == 'FAILED'
        # At least one phase did not end in success.
        assert not (phase1_succeeded and phase2_succeeded), (
            'FAILED reported but both phases ended in success - inconsistent. '
            f'log={invocation_log}'
        )
        # The Outcome field carries the last-failing outcome category.
        assert 'Outcome' in sent['data']
        assert sent['data']['Outcome'] in {
            handler.OUTCOME_MARKETPLACE_DENIED,
            handler.OUTCOME_OTHER_ERROR,
            handler.OUTCOME_TIMEOUT,
        }, f"unexpected Outcome={sent['data'].get('Outcome')}"

        # And the Outcome should match the classifier's category for the
        # last attempted invocation (which is the last entry in invocation_log
        # when the last phase exhausted MAX_ATTEMPTS without success).
        last = invocation_log[-1]
        if last == 'success':
            # Phase 1 succeeded, phase 2 ran and ended in failure - the failing
            # outcome is the last NON-success entry in phase 2.
            phase2_failures = [o for o in phase2 if o != 'success']
            assert phase2_failures, 'expected at least one phase 2 failure'
            last_failure = phase2_failures[-1]
        else:
            last_failure = last

        expected_map = {
            'marketplace_denied': handler.OUTCOME_MARKETPLACE_DENIED,
            'other_error': handler.OUTCOME_OTHER_ERROR,
            'timeout': handler.OUTCOME_TIMEOUT,
        }
        assert sent['data']['Outcome'] == expected_map[last_failure], (
            f"Outcome={sent['data']['Outcome']} does not match last failure "
            f"{last_failure} mapped to {expected_map[last_failure]}"
        )


def test_constants_match_design():
    """Sanity: the handler constants match the values quoted in the design."""
    assert handler.MAX_ATTEMPTS == 4
    assert handler.BACKOFF_SECONDS == 5
    assert handler.INVOCATION_TIMEOUT == 30
    assert handler.SUCCESS_RUNS_REQUIRED == 2


# -- Structured log shape -------------------------------------------------
# FOR ALL attempt outcomes emitted by the Pre-warm Lambda, the corresponding
# CloudWatch log entry is valid JSON and contains all of:
#   model_id (non-empty string), region (non-empty string),
#   attempt_count in {1,2,3,4},
#   outcome in {success, aws_marketplace_denied, other_error, timeout},
#   request_id (non-empty string).

VALID_OUTCOMES = {
    handler.OUTCOME_SUCCESS,             # 'success'
    handler.OUTCOME_MARKETPLACE_DENIED,  # 'aws_marketplace_denied'
    handler.OUTCOME_OTHER_ERROR,         # 'other_error'
    handler.OUTCOME_TIMEOUT,             # 'timeout'
}

ATTEMPT_FIELDS = ('model_id', 'region', 'attempt_count', 'outcome', 'request_id')


def _make_fake_invoke_once(trace):
    """Build a side_effect that consumes outcomes from `trace`, defaulting
    to 'other_error' when exhausted. Mirrors test_attempt_cap_and_two_success_rule.
    """
    trace_iter = iter(trace)

    def fake_invoke_once(client, model_id):
        try:
            outcome = next(trace_iter)
        except StopIteration:
            outcome = 'other_error'
        if outcome == 'success':
            return MagicMock()
        if outcome == 'marketplace_denied':
            raise handler.botocore.exceptions.ClientError(
                error_response={
                    'Error': {
                        'Code': 'AccessDeniedException',
                        'Message': 'aws-marketplace:Subscribe denied',
                    }
                },
                operation_name='InvokeModel',
            )
        if outcome == 'timeout':
            raise handler.botocore.exceptions.ReadTimeoutError(
                endpoint_url='https://bedrock-runtime.us-east-1.amazonaws.com'
            )
        raise RuntimeError('other_error stub')

    return fake_invoke_once


@given(trace=st.lists(outcome_strategy, min_size=1, max_size=8))
@settings(
    suppress_health_check=[HealthCheck.function_scoped_fixture],
    max_examples=100,
    deadline=None,
)
def test_log_shape_for_every_outcome(trace):
    """Structured log shape.

    Drive the handler with a configurable outcome trace, capture every log
    line emitted via handler.LOGGER.info, and assert that for each log line
    corresponding to an attempt (i.e., emitted by _log_attempt):

      1. The line is valid JSON.
      2. It contains model_id, region, attempt_count, outcome, request_id.
      3. model_id matches the env-var value.
      4. region matches the env-var value (us-east-1).
      5. attempt_count is an integer in {1, 2, 3, 4}.
      6. outcome is in {success, aws_marketplace_denied, other_error, timeout}.
      7. request_id is a non-empty string.
    """
    captured = []

    def fake_logger_info(msg, *args, **kwargs):
        # _log_attempt and _run_invocation_phase both pass a pre-serialized
        # JSON string as the message. We capture it verbatim.
        captured.append(msg)

    def fake_cfn_send(event, status, reason, data=None):
        # No-op: this test does not assert on CFN protocol, only on logs.
        pass

    event = {
        'RequestType': 'Create',
        'StackId': 'arn:aws:cloudformation:us-east-1:000000000000:stack/test/1',
        'RequestId': 'req-1',
        'LogicalResourceId': 'BedrockPrewarm',
        'PhysicalResourceId': 'phys-1',
        'ResponseURL': 'https://example.invalid/response',
    }

    with patch.object(handler, '_invoke_once',
                      side_effect=_make_fake_invoke_once(trace)), \
         patch.object(handler, '_cfn_send', side_effect=fake_cfn_send), \
         patch.object(handler.LOGGER, 'info', side_effect=fake_logger_info), \
         patch('time.sleep'):
        handler.handler(event, None)

    # Separate attempt logs (emitted by _log_attempt) from phase-summary logs
    # (emitted by _run_invocation_phase final block, which has a 'phase' key).
    attempt_logs = []
    for line in captured:
        # (1) Every captured line MUST be valid JSON (both _log_attempt AND
        # the phase summary call json.dumps before LOGGER.info).
        try:
            entry = json.loads(line)
        except (TypeError, ValueError) as exc:
            raise AssertionError(
                f'captured log line is not valid JSON: {line!r} ({exc})'
            )
        # Phase summary lines have a 'phase' field but not 'attempt_count' -
        # they are NOT subject to the P13 attempt-log contract.
        if 'phase' in entry:
            continue
        attempt_logs.append(entry)

    # Sanity: the handler always runs at least one attempt, so we must have
    # captured at least one attempt log.
    assert len(attempt_logs) >= 1, (
        f'no attempt logs captured for trace={trace}, all_logs={captured}'
    )

    expected_model_id = os.environ['BEDROCK_MODEL_ID']
    expected_region = os.environ['BEDROCK_REGION']

    for entry in attempt_logs:
        # (2) Required fields present.
        for field in ATTEMPT_FIELDS:
            assert field in entry, (
                f'missing field {field!r} in attempt log {entry}'
            )

        # (3) model_id is the configured value (non-empty string).
        assert isinstance(entry['model_id'], str)
        assert entry['model_id'] == expected_model_id, (
            f"model_id={entry['model_id']!r} != {expected_model_id!r}"
        )
        assert len(entry['model_id']) > 0

        # (4) region is the configured value (non-empty string).
        assert isinstance(entry['region'], str)
        assert entry['region'] == expected_region, (
            f"region={entry['region']!r} != {expected_region!r}"
        )
        assert len(entry['region']) > 0

        # (5) attempt_count is an integer in {1, 2, 3, 4}. bool is a subclass
        # of int in Python, exclude it explicitly.
        assert isinstance(entry['attempt_count'], int) \
            and not isinstance(entry['attempt_count'], bool), (
            f"attempt_count={entry['attempt_count']!r} is not an int"
        )
        assert entry['attempt_count'] in {1, 2, 3, 4}, (
            f"attempt_count={entry['attempt_count']} outside {{1,2,3,4}}"
        )

        # (6) outcome is in the canonical enum.
        assert entry['outcome'] in VALID_OUTCOMES, (
            f"outcome={entry['outcome']!r} not in {VALID_OUTCOMES}"
        )

        # (7) request_id is a non-empty string (UUID4 from the handler).
        assert isinstance(entry['request_id'], str)
        assert len(entry['request_id']) > 0


# -- Idempotence -----------------------------------------------------------

import os as _os
import tempfile as _tempfile
from unittest.mock import patch as _patch

import boto3 as _boto3  # noqa: E402


def _snapshot_tmp_count(tmp):
    """Count file entries directly under the given tmp dir."""
    try:
        return len([n for n in os.listdir(tmp)
                    if os.path.isfile(os.path.join(tmp, n))])
    except FileNotFoundError:
        return 0


@given(n=st.integers(min_value=1, max_value=10))
@settings(
    suppress_health_check=[HealthCheck.function_scoped_fixture],
    max_examples=20,
    deadline=None,
)
def test_idempotence_n_runs(n):
    """Driving the handler N times against the SAME mocked
    entitlement state must produce identical (status, Outcome) every run,
    must not mutate env vars, must not write to /tmp, and must only
    construct boto3 'bedrock-runtime' clients (no S3, DynamoDB, or other
    AWS resource).
    """
    # Same entitlement state across all runs: every Bedrock invocation
    # succeeds. The handler exits with SUCCESS + Outcome='success' on
    # all N runs because the trace is fixed and stateless.
    ENTITLEMENT_TRACE = ['success', 'success']  # phase1 + phase2 both pass

    # A private temp dir, so the count only ever reflects what the handler
    # itself writes. Pointing at the shared system tmp makes this assertion
    # environment-dependent: on a developer machine any unrelated process
    # creating a temporary file fails the test, while a Lambda container is
    # isolated and would pass.
    _tmp_ctx = _tempfile.TemporaryDirectory()
    tmp_dir = _tmp_ctx.name
    # Redirect tempfile itself, so anything the handler creates through the
    # standard library lands in the private dir and is therefore counted.
    # Done via tempfile.tempdir rather than the TMPDIR env var, because
    # Assertion 1 below checks that the handler leaves os.environ untouched.
    _tmp_saved = _tempfile.tempdir
    _tempfile.tempdir = tmp_dir

    # Snapshot pre-run state.
    env_before = dict(_os.environ)
    tmp_before = _snapshot_tmp_count(tmp_dir)
    real_boto3_client = _boto3.client
    client_constructions = []

    def tracked_boto3_client(service_name, *args, **kwargs):
        client_constructions.append(service_name)
        return real_boto3_client(service_name, *args, **kwargs)

    # We never let the trace be exhausted: same fixed deterministic outcomes
    # for every run. The mock returns 'success' on every _invoke_once call.
    def fake_invoke_once(client, model_id):
        return MagicMock()                              # always succeeds

    sent_per_run = []
    sleep_calls_per_run = []

    def fake_cfn_send(event, status, reason, data=None):
        sent_per_run[-1] = (status, (data or {}).get('Outcome'))

    def fake_sleep(seconds):
        sleep_calls_per_run[-1].append(seconds)

    event_template = {
        'RequestType': 'Create',
        'StackId': 'arn:aws:cloudformation:us-east-1:000000000000:stack/test/1',
        'RequestId': 'req-p12',
        'LogicalResourceId': 'BedrockPrewarm',
        'PhysicalResourceId': 'phys-p12',
        'ResponseURL': 'https://example.invalid/response',
    }

    for _ in range(n):
        sent_per_run.append(None)
        sleep_calls_per_run.append([])
        with patch.object(handler, '_invoke_once', side_effect=fake_invoke_once), \
             patch.object(handler, '_cfn_send', side_effect=fake_cfn_send), \
             patch('time.sleep', side_effect=fake_sleep), \
             _patch('boto3.client', side_effect=tracked_boto3_client):
            handler.handler(dict(event_template), None)

    # ----- Assertion 1: All N runs return identical (status, Outcome) ----
    first = sent_per_run[0]
    assert first is not None, 'handler did not call _cfn_send on run 0'
    for i, result in enumerate(sent_per_run):
        assert result == first, (
            f'run {i} returned {result} but run 0 returned {first} - '
            f'idempotence violated'
        )
    # Sanity: with the all-success trace, status must be SUCCESS.
    assert first == ('SUCCESS', handler.OUTCOME_SUCCESS), (
        f'expected SUCCESS/success on all-success trace, got {first}'
    )

    # ----- Assertion 2: No backoff sleep on the happy path ---------------
    # With every attempt succeeding on the first try, no run should call
    # time.sleep - so no state carries across runs via the sleep loop.
    for i, sleeps in enumerate(sleep_calls_per_run):
        assert sleeps == [], (
            f'run {i} called time.sleep with {sleeps} on all-success trace - '
            f'no backoff expected, possible state leak'
        )

    # ----- Assertion 3: No /tmp file written by the handler --------------
    tmp_after = _snapshot_tmp_count(tmp_dir)
    _tempfile.tempdir = _tmp_saved
    _tmp_ctx.cleanup()
    assert tmp_after - tmp_before == 0, (
        f'handler wrote {tmp_after - tmp_before} file(s) to {tmp_dir} '
        f'across {n} runs - handler must not persist any state to /tmp'
    )

    # ----- Assertion 4: Only 'bedrock-runtime' clients constructed -------
    # And exactly N constructions (one per handler invocation - no caching
    # between runs that would carry state across).
    assert all(s == 'bedrock-runtime' for s in client_constructions), (
        f'handler constructed non-bedrock-runtime clients: '
        f'{set(client_constructions)} - the design forbids S3/DynamoDB/other'
    )
    assert len(client_constructions) == n, (
        f'expected {n} boto3.client calls (one per run, no caching), got '
        f'{len(client_constructions)}'
    )

    # ----- Assertion 5: Env vars not mutated by the handler --------------
    env_after = dict(_os.environ)
    if env_after != env_before:
        added = set(env_after) - set(env_before)
        removed = set(env_before) - set(env_after)
        changed = {
            k: (env_before[k], env_after[k])
            for k in env_after
            if k in env_before and env_before[k] != env_after[k]
        }
        raise AssertionError(
            'handler mutated os.environ across runs - no state leakage '
            'allowed. '
            f'added={added}, removed={removed}, changed={changed}'
        )
