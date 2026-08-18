# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Validates, at deploy time, that the chosen BedrockModelId is generally
# available (on the public model list for at least 14 calendar days) and that
# model access is enabled in the deploy Region. Fails the stack early rather
# than letting a participant discover an unavailable model mid-lab.

import json
import os
import re
import urllib.request
import urllib.error
from datetime import datetime, timezone

import boto3
import urllib3

WORKSHOP_DOC_URL = os.environ.get(
    'WORKSHOP_DOC_URL',
    'https://catalog.workshops.aws/docs/en-US/detailed-documentation/marketplace',
)
MIN_DAYS_ON_LIST_DEFAULT = int(os.environ.get('MIN_DAYS_ON_LIST', '14'))

http = urllib3.PoolManager()


def _cfn_send(event, status, reason, data=None):
    body = {
        'Status': status,
        'Reason': reason,
        'PhysicalResourceId': event.get('PhysicalResourceId', event['LogicalResourceId']),
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': data or {},
    }
    payload = json.dumps(body).encode('utf-8')
    http.request(
        'PUT',
        event['ResponseURL'],
        body=payload,
        headers={'content-type': '', 'content-length': str(len(payload))},
    )


def _fetch_supported_models_table():
    req = urllib.request.Request(
        WORKSHOP_DOC_URL,
        headers={'User-Agent': 'supported-list-validator/1.0'},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode('utf-8', errors='replace')


def _extract_model_added_date(html: str, model_id: str):
    # Parse the supported-models table. We expect each supported model to be
    # listed with the model id and an "Added" date in ISO format (YYYY-MM-DD).
    # The validator is intentionally tolerant: any line containing the model id
    # AND a YYYY-MM-DD date is taken as the added-date.
    for line in html.splitlines():
        if model_id in line:
            m = re.search(r'(\d{4}-\d{2}-\d{2})', line)
            if m:
                return datetime.strptime(m.group(1), '%Y-%m-%d').replace(tzinfo=timezone.utc)
    return None


def _check_bedrock_region_access(region: str, model_id: str):
    """Checks whether the configured model is accessible in the region.

    The id can be of two natures and the APIs are DIFFERENT:

      - Cross-region inference profile, with a region prefix:
        `us.anthropic.claude-haiku-4-5-20251001-v1:0`
        -> validate with GetInferenceProfile

      - Plain foundation model:
        `anthropic.claude-haiku-4-5-20251001-v1:0`
        -> validate with GetFoundationModel

    Passing an inference profile to GetFoundationModel returns
    ResourceNotFoundException ("Model not found"), which made this validation
    reject a perfectly accessible model and take down the whole stack.
    The workshop uses the inference profile on purpose: the plain foundation
    model id fails on on-demand invocation.
    """
    client = boto3.client('bedrock', region_name=region)

    # Inference profile prefix: 'us.', 'eu.', 'apac.', 'us-gov.'
    is_inference_profile = bool(re.match(r'^[a-z]{2}(-[a-z]+)?\.', model_id))

    try:
        if is_inference_profile:
            client.get_inference_profile(inferenceProfileIdentifier=model_id)
        else:
            client.get_foundation_model(modelIdentifier=model_id)
        return True, None
    except Exception as exc:  # ModelNotReadyException, ResourceNotFoundException, AccessDeniedException
        return False, f'{type(exc).__name__}: {exc}'


def _looks_machine_readable(html: str) -> bool:
    """Did the supported-models page deliver extractable content?

    The reference URL is a SPA: it answers ~900 bytes with an "enable
    JavaScript" notice and no table. Without this guard, the extraction
    returns None for every model and the validation rejects indiscriminately.
    """
    if len(html) < 4096:
        return False
    if 'enable JavaScript' in html and '<table' not in html:
        return False
    return '<table' in html or '<td' in html


def handler(event, _context):
    request_type = event.get('RequestType', 'Create')
    if request_type == 'Delete':
        _cfn_send(event, 'SUCCESS', 'Delete is a no-op')
        return

    props = event.get('ResourceProperties', {})
    model_id = props.get('ModelId')
    region = props.get('Region')
    min_days = int(props.get('MinDaysOnList', MIN_DAYS_ON_LIST_DEFAULT))

    if not model_id or not region:
        _cfn_send(event, 'FAILED', 'ModelId and Region are required properties')
        return

    # Fail explicitly if Bedrock model access is unavailable in the deploy Region
    accessible, access_err = _check_bedrock_region_access(region, model_id)
    if not accessible:
        _cfn_send(
            event,
            'FAILED',
            f'Bedrock model access unavailable in region {region} for model {model_id} - {access_err}',
        )
        return

    # 14-day rule on the supported-models list.
    # WARNING - DELIBERATE BEHAVIOR CHANGE.
    # The reference page (WORKSHOP_DOC_URL) is a JavaScript application: the
    # delivered HTML is under 1 KB and only says "You need to enable
    # JavaScript to run this app". There is no table to extract. While this
    # check was blocking, it rejected ANY model and took the stack down on
    # every deploy with Environment=prod - including provably accessible
    # models, already validated by the Bedrock check above.
    # Adopted behavior:
    #   - if the source is machine-readable, the rule remains BLOCKING
    #     (a missing or recent model fails, as before);
    #   - if the source is not readable, emit a WARNING and continue, leaving
    #     on record that the rule needs manual verification.
    # The check that actually protects provisioning - real access to the model
    # in the region - remains blocking and has just passed.
    try:
        html = _fetch_supported_models_table()
    except Exception as exc:
        _cfn_send(
            event,
            'SUCCESS',
            f'WARNING: could not query {WORKSHOP_DOC_URL} ({exc}). '
            f'Access to model {model_id} in {region} confirmed; the {min_days}-day '
            f'rule on the supported list needs manual verification.',
            data={'SupportedListChecked': 'false'},
        )
        return

    # Source unusable for automatic extraction (client-side rendered page).
    if not _looks_machine_readable(html):
        print(
            f'WARNING: {WORKSHOP_DOC_URL} does not expose the table in the HTML '
            f'({len(html)} bytes); the {min_days}-day rule was not automatically '
            f'verified for {model_id}.'
        )
        _cfn_send(
            event,
            'SUCCESS',
            f'Access to model {model_id} confirmed in {region}. '
            f'WARNING: the supported list cannot be read automatically '
            f'(client-side rendered page); manually verify the '
            f'{min_days}-day rule.',
            data={'SupportedListChecked': 'false'},
        )
        return

    added = _extract_model_added_date(html, model_id)
    if added is None:
        _cfn_send(
            event,
            'FAILED',
            f'Model {model_id} is not present on the supported list at {WORKSHOP_DOC_URL}',
        )
        return

    days_on_list = (datetime.now(timezone.utc) - added).days
    if days_on_list < min_days:
        _cfn_send(
            event,
            'FAILED',
            f'Model {model_id} has been on the supported list for {days_on_list} day(s); '
            f'minimum required is {min_days} days',
        )
        return

    _cfn_send(
        event,
        'SUCCESS',
        f'Model {model_id} is supported in {region} and has been on the supported list for {days_on_list} day(s)',
        data={'DaysOnList': str(days_on_list)},
    )
