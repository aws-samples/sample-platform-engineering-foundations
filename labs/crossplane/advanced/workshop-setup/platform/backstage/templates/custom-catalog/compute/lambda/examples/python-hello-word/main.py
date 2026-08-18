import os

def lambda_handler(event, context):
    """
    Simple AWS Lambda function that returns a Hello World message.
    
    Parameters:
    event (dict): Data for the Lambda function to process
    context (LambdaContext): Methods and properties that provide information about the invocation,
                            function, and execution environment
    
    Returns:
    dict: Response containing a Hello World message
    """
    print('Lambda function invoked')
    
    print("All Environment Variables:")
    for key, value in os.environ.items():
        print(f"{key}: {value}")
    
    # You can process the event data here if needed
    
    return {
        'statusCode': 200,
        'body': 'Hello, World! This is a simple AWS Lambda function.'
    }