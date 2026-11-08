output "lambda_function_name" {
  description = "Deployed Lambda function name."
  value       = aws_lambda_function.job_scout.function_name
}

output "dynamodb_table_name" {
  description = "Single-table DynamoDB table name."
  value       = aws_dynamodb_table.job_scout.name
}

output "schedule_name" {
  description = "EventBridge Scheduler schedule name."
  value       = aws_scheduler_schedule.job_scout.name
}

output "schedule_enabled" {
  description = "Whether the schedule is enabled."
  value       = var.schedule_enabled
}

output "sender_identity_arn" {
  description = "SES sender identity to verify."
  value       = aws_ses_email_identity.sender.arn
}

output "github_deploy_role_arn" {
  description = "OIDC deployment role ARN, when enabled. Store as the AWS_ROLE_ARN GitHub environment variable."
  value       = var.enable_github_oidc ? aws_iam_role.github_deploy[0].arn : null
}
