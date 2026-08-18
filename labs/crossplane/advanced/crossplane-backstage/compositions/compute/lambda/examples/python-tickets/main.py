import json
import uuid
import os
import boto3
import base64
from datetime import datetime
from boto3.dynamodb.conditions import Key, Attr
from botocore.exceptions import ClientError

# Initialize DynamoDB client
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['DYNAMO_DB_TABLE_NAME'])

def lambda_handler(event, context):
    """
    Handle API Gateway requests for ticket operations
    """
    print(f"Processing request: {event['httpMethod']} {event['resource']}")
    
    if event.get('body', None) and event.get('isBase64Encoded', False):
        event['body'] = base64.b64decode(event['body']).decode('utf-8')
    
    http_method = event['httpMethod']
    resource_path = event['resource']
    
    # Route the request based on HTTP method and path
    if http_method == 'GET' and resource_path == '/tickets':
        return get_tickets(event)
    elif http_method == 'POST' and resource_path == '/tickets':
        return create_ticket(event)
    elif http_method == 'GET' and resource_path == '/tickets/{ticketId}':
        return get_ticket(event)
    elif http_method == 'PUT' and resource_path == '/tickets/{ticketId}':
        return update_ticket(event)
    elif http_method == 'DELETE' and resource_path == '/tickets/{ticketId}':
        return delete_ticket(event)
    else:
        return {
            'statusCode': 400,
            'body': json.dumps({'error': 'Invalid endpoint or method'})
        }

def get_tickets(event):
    """
    Get all tickets, with optional filtering by status
    """
    query_params = event.get('queryStringParameters', {}) or {}
    status_filter = query_params.get('status')
    limit = int(query_params.get('limit', '10'))
    
    try:
        # If status is provided, filter tickets by status
        if status_filter:
            response = table.scan(
                FilterExpression=Attr('status').eq(status_filter),
                Limit=limit
            )
        else:
            response = table.scan(Limit=limit)
        
        tickets = response['Items']
        
        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps(tickets)
        }
    except ClientError as e:
        print(f"Error getting tickets: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': 'Failed to retrieve tickets'})
        }

def create_ticket(event):
    """
    Create a new ticket in DynamoDB
    """
    try:
        # Parse request body
        body = json.loads(event['body'])
        
        # Generate a new ticket ID
        ticket_id = f"ticket-{uuid.uuid4().hex[:8]}"
        current_time = datetime.utcnow().isoformat()
        
        # Create new ticket
        ticket = {
            "id": ticket_id,
            "title": body['title'],
            "description": body.get('description', ''),
            "status": "open",
            "priority": body.get('priority', 'medium'),
            "assignee": body.get('assignee'),
            "created_at": current_time,
            "updated_at": current_time
        }
        
        # Save to DynamoDB
        table.put_item(Item=ticket)
        
        return {
            'statusCode': 201,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps(ticket)
        }
    except KeyError as e:
        return {
            'statusCode': 400,
            'body': json.dumps({'error': f'Missing required field: {str(e)}'})
        }
    except ClientError as e:
        print(f"Error creating ticket: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': 'Failed to create ticket'})
        }

def get_ticket(event):
    """
    Get a specific ticket by ID
    """
    try:
        # Get ticket ID from path parameters
        ticket_id = event['pathParameters']['ticketId']
        
        # Fetch ticket from DynamoDB
        response = table.get_item(
            Key={
                'id': ticket_id
            }
        )
        
        # Check if the ticket exists
        if 'Item' not in response:
            return {
                'statusCode': 404,
                'body': json.dumps({'error': f'Ticket {ticket_id} not found'})
            }
        
        ticket = response['Item']
        
        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps(ticket)
        }
    except ClientError as e:
        print(f"Error getting ticket: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': 'Failed to retrieve ticket'})
        }

def update_ticket(event):
    """
    Update an existing ticket
    """
    try:
        # Get ticket ID and update data
        ticket_id = event['pathParameters']['ticketId']
        updates = json.loads(event['body'])
        
        # Check if the ticket exists
        response = table.get_item(
            Key={
                'id': ticket_id
            }
        )
        
        if 'Item' not in response:
            return {
                'statusCode': 404,
                'body': json.dumps({'error': f'Ticket {ticket_id} not found'})
            }
        
        # Prepare update expression and attribute values
        update_expression = "SET "
        expression_attribute_values = {}
        
        # Build the update expression for each field
        for field in ['title', 'description', 'status', 'priority', 'assignee']:
            if field in updates:
                update_expression += f"{field} = :{field}, "
                expression_attribute_values[f":{field}"] = updates[field]
        
        # Add updated timestamp
        update_expression += "updated_at = :updated_at"
        expression_attribute_values[":updated_at"] = datetime.utcnow().isoformat()
        
        # Update the ticket in DynamoDB
        response = table.update_item(
            Key={
                'id': ticket_id
            },
            UpdateExpression=update_expression,
            ExpressionAttributeValues=expression_attribute_values,
            ReturnValues="ALL_NEW"
        )
        
        updated_ticket = response['Attributes']
        
        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps(updated_ticket)
        }
    except ClientError as e:
        print(f"Error updating ticket: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': 'Failed to update ticket'})
        }

def delete_ticket(event):
    """
    Delete a ticket by ID
    """
    try:
        # Get ticket ID
        ticket_id = event['pathParameters']['ticketId']
        
        # Check if the ticket exists before deleting
        response = table.get_item(
            Key={
                'id': ticket_id
            }
        )
        
        if 'Item' not in response:
            return {
                'statusCode': 404,
                'body': json.dumps({'error': f'Ticket {ticket_id} not found'})
            }
        
        # Delete the ticket from DynamoDB
        table.delete_item(
            Key={
                'id': ticket_id
            }
        )
        
        return {
            'statusCode': 204,
            'body': ''
        }
    except ClientError as e:
        print(f"Error deleting ticket: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': 'Failed to delete ticket'})
        }