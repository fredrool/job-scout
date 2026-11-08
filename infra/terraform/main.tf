data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  name                  = "job-scout-${var.environment}"
  lambda_log_group_name = "/aws/lambda/${local.name}"
  table_arn             = aws_dynamodb_table.job_scout.arn
  inference_profile_arn = "arn:${data.aws_partition.current.partition}:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/${var.bedrock_inference_profile_id}"
  model_arns = [
    for region in var.bedrock_model_regions :
    "arn:${data.aws_partition.current.partition}:bedrock:${region}::foundation-model/${var.bedrock_model_id}"
  ]
}

resource "aws_dynamodb_table" "job_scout" {
  name         = local.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  attribute {
    name = "GSI1PK"
    type = "S"
  }

  attribute {
    name = "GSI1SK"
    type = "S"
  }

  attribute {
    name = "GSI2PK"
    type = "S"
  }

  attribute {
    name = "GSI2SK"
    type = "S"
  }

  attribute {
    name = "GSI3PK"
    type = "S"
  }

  attribute {
    name = "GSI3SK"
    type = "S"
  }

  global_secondary_index {
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "GSI2"
    hash_key        = "GSI2PK"
    range_key       = "GSI2SK"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "GSI3"
    hash_key        = "GSI3PK"
    range_key       = "GSI3SK"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = var.dynamodb_point_in_time_recovery
  }

  server_side_encryption {
    enabled = true
  }

  deletion_protection_enabled = var.dynamodb_deletion_protection
}

resource "aws_ses_email_identity" "sender" {
  email = var.sender_email
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = local.lambda_log_group_name
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "lambda" {
  name = "${local.name}-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "lambda" {
  name = "${local.name}-runtime"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteLambdaLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.lambda.arn}:*"
      },
      {
        Sid    = "UseJobScoutTable"
        Effect = "Allow"
        Action = [
          "dynamodb:BatchGetItem",
          "dynamodb:BatchWriteItem",
          "dynamodb:ConditionCheckItem",
          "dynamodb:DeleteItem",
          "dynamodb:DescribeTable",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
          "dynamodb:UpdateItem"
        ]
        Resource = [local.table_arn, "${local.table_arn}/index/*"]
      },
      {
        Sid      = "UseClaudeInferenceProfile"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel"]
        Resource = concat([local.inference_profile_arn], local.model_arns)
      },
      {
        Sid      = "SendJobScoutEmail"
        Effect   = "Allow"
        Action   = ["ses:SendEmail"]
        Resource = aws_ses_email_identity.sender.arn
        Condition = {
          "ForAllValues:StringEquals" = {
            "ses:Recipients" = [var.notification_email]
          }
        }
      }
    ]
  })
}

resource "aws_lambda_function" "job_scout" {
  function_name    = local.name
  description      = "Scheduled Job Scout collection and notification"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  handler          = var.lambda_handler
  filename         = var.lambda_artifact_path
  source_code_hash = filebase64sha256(var.lambda_artifact_path)
  memory_size      = var.lambda_memory_mb
  timeout          = var.lambda_timeout_seconds
  architectures    = ["arm64"]

  environment {
    variables = merge(
      {
        AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
        AWS_REGION                          = var.aws_region
        NODE_ENV                            = "production"
        MOCK_MODE                           = "false"
        BEDROCK_MODEL_ID                    = var.bedrock_inference_profile_id
        DYNAMODB_TABLE_NAME                 = aws_dynamodb_table.job_scout.name
        NOTIFICATION_EMAIL                  = var.notification_email
        SENDER_EMAIL                        = var.sender_email
        USER_ID                             = "default"
        SCORE_THRESHOLD                     = tostring(var.score_threshold)
        DIGEST_LIMIT                        = tostring(var.digest_limit)
        MAX_BEDROCK_CALLS_PER_SCAN          = tostring(var.max_bedrock_calls_per_scan)
        MAX_JOBS_PER_SCAN                   = tostring(var.max_jobs_per_scan)
        MAX_REQUESTS_PER_SCAN               = tostring(var.max_requests_per_scan)
        MAX_RUNTIME_MS                      = tostring((var.lambda_timeout_seconds - 30) * 1000)
        PRESENTATION_TIMEZONE               = var.presentation_timezone
        DRY_RUN                             = tostring(var.dry_run)
      },
      var.adzuna_app_id == null ? {} : { ADZUNA_APP_ID = var.adzuna_app_id },
      var.adzuna_app_key == null ? {} : { ADZUNA_APP_KEY = var.adzuna_app_key },
      var.jooble_api_key == null ? {} : { JOOBLE_API_KEY = var.jooble_api_key }
    )
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.lambda
  ]
}

resource "aws_iam_role" "scheduler" {
  name = "${local.name}-scheduler"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "scheduler.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  name = "${local.name}-invoke"
  role = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.job_scout.arn
    }]
  })
}

resource "aws_scheduler_schedule" "job_scout" {
  name                         = local.name
  description                  = "Run Job Scout every four hours"
  schedule_expression          = "rate(4 hours)"
  state                        = var.schedule_enabled ? "ENABLED" : "DISABLED"
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.job_scout.arn
    role_arn = aws_iam_role.scheduler.arn

    retry_policy {
      maximum_event_age_in_seconds = 3600
      maximum_retry_attempts       = 2
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "${local.name}-errors"
  alarm_description   = "Job Scout Lambda emitted an error."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.job_scout.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  alarm_name          = "${local.name}-throttles"
  alarm_description   = "Job Scout Lambda was throttled."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.job_scout.function_name
  }
}

resource "aws_budgets_budget" "monthly" {
  count = var.enable_budget ? 1 : 0

  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.notification_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.notification_email]
  }
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.enable_github_oidc ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

resource "aws_iam_role" "github_deploy" {
  count = var.enable_github_oidc ? 1 : 0

  name = "${local.name}-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.github[0].arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:environment:${var.environment}"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_deploy" {
  count = var.enable_github_oidc ? 1 : 0

  name = "${local.name}-terraform"
  role = aws_iam_role.github_deploy[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListTerraformState"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = "arn:${data.aws_partition.current.partition}:s3:::${var.terraform_state_bucket_name}"
      },
      {
        Sid    = "UseTerraformState"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = [
          "arn:${data.aws_partition.current.partition}:s3:::${var.terraform_state_bucket_name}/${var.environment}/job-scout.tfstate",
          "arn:${data.aws_partition.current.partition}:s3:::${var.terraform_state_bucket_name}/${var.environment}/job-scout.tfstate.tflock"
        ]
      },
      {
        Sid    = "ManageBudget"
        Effect = "Allow"
        Action = [
          "budgets:CreateBudget",
          "budgets:DeleteBudget",
          "budgets:DescribeBudget",
          "budgets:ModifyBudget"
        ]
        Resource = "*"
      },
      {
        Sid    = "ManageAlarms"
        Effect = "Allow"
        Action = [
          "cloudwatch:DeleteAlarms",
          "cloudwatch:PutMetricAlarm"
        ]
        Resource = "arn:${data.aws_partition.current.partition}:cloudwatch:${var.aws_region}:${data.aws_caller_identity.current.account_id}:alarm:${local.name}-*"
      },
      {
        Sid      = "ReadAlarmsAndLogs"
        Effect   = "Allow"
        Action   = ["cloudwatch:DescribeAlarms", "logs:DescribeLogGroups"]
        Resource = "*"
      },
      {
        Sid    = "ManageTable"
        Effect = "Allow"
        Action = [
          "dynamodb:CreateTable",
          "dynamodb:DeleteTable",
          "dynamodb:DescribeContinuousBackups",
          "dynamodb:DescribeTable",
          "dynamodb:DescribeTimeToLive",
          "dynamodb:ListTagsOfResource",
          "dynamodb:TagResource",
          "dynamodb:UntagResource",
          "dynamodb:UpdateContinuousBackups",
          "dynamodb:UpdateTable",
          "dynamodb:UpdateTimeToLive"
        ]
        Resource = [
          "arn:${data.aws_partition.current.partition}:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${local.name}",
          "arn:${data.aws_partition.current.partition}:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${local.name}/index/*"
        ]
      },
      {
        Sid    = "ManageFunction"
        Effect = "Allow"
        Action = [
          "lambda:CreateFunction",
          "lambda:DeleteFunction",
          "lambda:GetFunction",
          "lambda:GetFunctionCodeSigningConfig",
          "lambda:GetPolicy",
          "lambda:ListVersionsByFunction",
          "lambda:TagResource",
          "lambda:UntagResource",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration"
        ]
        Resource = "arn:${data.aws_partition.current.partition}:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${local.name}"
      },
      {
        Sid    = "ManageLogGroup"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:DeleteLogGroup",
          "logs:ListTagsForResource",
          "logs:PutRetentionPolicy",
          "logs:TagResource",
          "logs:UntagResource"
        ]
        Resource = "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:${local.lambda_log_group_name}:*"
      },
      {
        Sid    = "ManageSchedule"
        Effect = "Allow"
        Action = [
          "scheduler:CreateSchedule",
          "scheduler:DeleteSchedule",
          "scheduler:GetSchedule",
          "scheduler:TagResource",
          "scheduler:UntagResource",
          "scheduler:UpdateSchedule"
        ]
        Resource = "arn:${data.aws_partition.current.partition}:scheduler:${var.aws_region}:${data.aws_caller_identity.current.account_id}:schedule/default/${local.name}"
      },
      {
        Sid    = "ManageSenderIdentity"
        Effect = "Allow"
        Action = [
          "ses:DeleteIdentity",
          "ses:GetIdentityVerificationAttributes",
          "ses:ListTagsForResource",
          "ses:TagResource",
          "ses:UntagResource",
          "ses:VerifyEmailIdentity"
        ]
        Resource = "arn:${data.aws_partition.current.partition}:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/${var.sender_email}"
      },
      {
        Sid    = "ManageJobScoutRoles"
        Effect = "Allow"
        Action = [
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:DeleteRolePolicy",
          "iam:GetRole",
          "iam:GetRolePolicy",
          "iam:ListInstanceProfilesForRole",
          "iam:ListRolePolicies",
          "iam:ListAttachedRolePolicies",
          "iam:PutRolePolicy",
          "iam:TagRole",
          "iam:UntagRole",
          "iam:UpdateAssumeRolePolicy"
        ]
        Resource = [
          "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${local.name}-lambda",
          "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${local.name}-scheduler"
        ]
      },
      {
        Sid    = "ReadBootstrapIdentity"
        Effect = "Allow"
        Action = [
          "iam:GetOpenIDConnectProvider",
          "iam:GetRole",
          "iam:GetRolePolicy",
          "iam:ListAttachedRolePolicies",
          "iam:ListInstanceProfilesForRole",
          "iam:ListRolePolicies"
        ]
        Resource = [
          aws_iam_openid_connect_provider.github[0].arn,
          aws_iam_role.github_deploy[0].arn
        ]
      },
      {
        Sid      = "PassJobScoutRoles"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${local.name}-*"
        Condition = {
          StringEquals = {
            "iam:PassedToService" = ["lambda.amazonaws.com", "scheduler.amazonaws.com"]
          }
        }
      }
    ]
  })
}
