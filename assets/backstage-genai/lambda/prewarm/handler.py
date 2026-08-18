# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Pre-warms Amazon Bedrock so the first invocation from the Backstage GenAI
# plugin does not pay the cold-start penalty in front of a workshop audience.
# Retries with backoff, is idempotent, and emits one structured log line per
# attempt.

import json
import logging
import os
import time
import uuid

import boto3
import botocore.exceptions
import urllib3
from botocore.config import Config

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)

MAX_ATTEMPTS = 4
BACKOFF_SECONDS = 5
INVOCATION_TIMEOUT = 30                # per-invocation read_timeout
SUCCESS_RUNS_REQUIRED = 2              # two-consecutive-success rule

_http = urllib3.PoolManager()


# -- Outcome categories -----------------------------------------

OUTCOME_SUCCESS = 'success'
OUTCOME_MARKETPLACE_DENIED = 'aws_marketplace_denied'
OUTCOME_OTHER_ERROR = 'other_error'
OUTCOME_TIMEOUT = 'timeout'


# -- CloudWatch structured log emitter ---------------------------

def _log_attempt(model_id, region, attempt_count, outcome, request_id):
    LOGGER.info(json.dumps({
        'model_id': model_id,
        'region': region,
        'attempt_count': attempt_count,    # 1..4
        'outcome': outcome,                # success | aws_marketplace_denied | other_error | timeout
        'request_id': request_id,
    }))


# -- Single Bedrock invocation with timeout ----------------------

def _invoke_once(client, model_id):
    return client.invoke_model(
        modelId=model_id,
        body=json.dumps({
            'anthropic_version': 'bedrock-2023-05-31',
            'max_tokens': 1,
            'messages': [{'role': 'user', 'content': 'ok'}],
        }),
        contentType='application/json',
        accept='application/json',
    )


def _classify_exception(exc):
    if isinstance(exc, botocore.exceptions.ReadTimeoutError):
        return OUTCOME_TIMEOUT
    if isinstance(exc, botocore.exceptions.ClientError):
        err = exc.response.get('Error', {})
        code = err.get('Code', '')
        msg = err.get('Message', '') or str(exc)
        if code in ('AccessDeniedException',) and 'aws-marketplace:Subscribe' in msg:
            return OUTCOME_MARKETPLACE_DENIED
        return OUTCOME_OTHER_ERROR
    return OUTCOME_OTHER_ERROR


# -- One invocation phase with up to 4 attempts -------------

def _run_invocation_phase(client, model_id, region, request_id, phase_label):
    outcome = OUTCOME_OTHER_ERROR
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            _invoke_once(client, model_id)
            _log_attempt(model_id, region, attempt, OUTCOME_SUCCESS, request_id)
            return OUTCOME_SUCCESS
        except Exception as exc:                                     # noqa: BLE001
            outcome = _classify_exception(exc)
            _log_attempt(model_id, region, attempt, outcome, request_id)
            if attempt < MAX_ATTEMPTS:
                time.sleep(BACKOFF_SECONDS)
    LOGGER.info(json.dumps({
        'phase': phase_label,
        'request_id': request_id,
        'final_outcome': outcome,
    }))
    return outcome


# -- CFN custom-resource response protocol --------------------------------

def _cfn_send(event, status, reason, data=None):
    body = {
        'Status': status,                                            # SUCCESS | FAILED
        'Reason': reason,
        'PhysicalResourceId': event.get('PhysicalResourceId', event['LogicalResourceId']),
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': data or {},
    }
    payload = json.dumps(body).encode('utf-8')
    _http.request(
        'PUT',
        event['ResponseURL'],
        body=payload,
        headers={'content-type': '', 'content-length': str(len(payload))},
    )


# -- Handler ---------------------------------------------------------------

def handler(event, _context):
    request_type = event.get('RequestType', 'Create')
    if request_type == 'Delete':                       # Idempotent no-op on stack delete
        _cfn_send(event, 'SUCCESS', 'Delete is a no-op')
        return

    model_id = os.environ['BEDROCK_MODEL_ID']
    region = os.environ['BEDROCK_REGION']
    request_id = str(uuid.uuid4())

    client = boto3.client(
        'bedrock-runtime',
        region_name=region,
        config=Config(read_timeout=INVOCATION_TIMEOUT, retries={'max_attempts': 0}),
    )

    final_outcome = OUTCOME_OTHER_ERROR
    for run in range(1, SUCCESS_RUNS_REQUIRED + 1):    # two consecutive successes
        outcome = _run_invocation_phase(client, model_id, region, request_id, f'run{run}')
        final_outcome = outcome
        if outcome != OUTCOME_SUCCESS:
            break

    status = 'SUCCESS' if final_outcome == OUTCOME_SUCCESS else 'FAILED'
    reason = (
        f'prewarm {final_outcome} for model={model_id} region={region} '
        f'request_id={request_id}'
    )
    _cfn_send(event, status, reason, data={'Outcome': final_outcome})
