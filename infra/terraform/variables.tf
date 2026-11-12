variable "aws_region" {
  description = "AWS region for regional resources and the Bedrock inference-profile entry point."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod."
  }
}

variable "lambda_artifact_path" {
  description = "Path to the prebuilt Lambda ZIP (Node.js 22), relative to this Terraform directory or absolute."
  type        = string
  default     = "../../.artifacts/job-scout-lambda.zip"
}

variable "lambda_handler" {
  description = "Handler exported by the packaged Lambda."
  type        = string
  default     = "index.handler"
}

variable "lambda_timeout_seconds" {
  description = "Lambda timeout."
  type        = number
  default     = 300
}

variable "lambda_memory_mb" {
  description = "Lambda memory allocation."
  type        = number
  default     = 512
}

variable "notification_email" {
  description = "Destination for Job Scout results and optional budget notifications. Must be verified while SES is sandboxed."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.notification_email))
    error_message = "notification_email must look like an email address."
  }
}

variable "sender_email" {
  description = "SES From address. Verify this identity before enabling the schedule."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.sender_email))
    error_message = "sender_email must look like an email address."
  }
}

variable "schedule_enabled" {
  description = "Whether the four-hour EventBridge Scheduler schedule is enabled."
  type        = bool
  default     = false
}

variable "dry_run" {
  description = "Run discovery and evaluation without sending SES email."
  type        = bool
  default     = true
}

variable "score_threshold" {
  description = "Minimum deterministic score to evaluate and notify."
  type        = number
  default     = 80
}

variable "digest_limit" {
  description = "Maximum jobs in one email; overflow remains pending."
  type        = number
  default     = 25
}

variable "max_bedrock_calls_per_scan" {
  description = "Hard cap on Bedrock evaluations in one scan."
  type        = number
  default     = 50
}

variable "max_jobs_per_scan" {
  description = "Hard cap on normalized jobs processed in one scan."
  type        = number
  default     = 1000
}

variable "max_requests_per_scan" {
  description = "Hard cap on company source requests in one scan."
  type        = number
  default     = 200
}

variable "presentation_timezone" {
  description = "IANA timezone used in digest presentation."
  type        = string
  default     = "America/Toronto"
}

variable "adzuna_app_id" {
  description = "Optional Adzuna application ID. Supply securely; do not commit it to tfvars."
  type        = string
  sensitive   = true
  default     = null
  nullable    = true
}

variable "adzuna_app_key" {
  description = "Optional Adzuna application key. Supply securely; do not commit it to tfvars."
  type        = string
  sensitive   = true
  default     = null
  nullable    = true
}

variable "jooble_api_key" {
  description = "Optional Jooble API key. Jooble remains disabled until quota is approved."
  type        = string
  sensitive   = true
  default     = null
  nullable    = true
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 30
}

variable "dynamodb_point_in_time_recovery" {
  description = "Enable DynamoDB point-in-time recovery."
  type        = bool
  default     = true
}

variable "dynamodb_deletion_protection" {
  description = "Protect the DynamoDB table from accidental deletion. Disable explicitly before destroy."
  type        = bool
  default     = true
}

variable "bedrock_inference_profile_id" {
  description = "Model or inference profile ID passed to Bedrock Converse as BEDROCK_MODEL_ID. Default: Claude Haiku 4.5. To evaluate Nova Micro: us.amazon.nova-micro-v1:0."
  type        = string
  default     = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
}

variable "bedrock_model_id" {
  description = "Foundation model ARN segment for IAM (InvokeModel). Haiku: anthropic.claude-haiku-4-5-20251001-v1:0. Nova Micro: amazon.nova-micro-v1:0."
  type        = string
  default     = "anthropic.claude-haiku-4-5-20251001-v1:0"
}

variable "bedrock_model_regions" {
  description = "US regions to which the inference profile may route. Keep aligned with AWS profile destinations."
  type        = set(string)
  default     = ["us-east-1", "us-east-2", "us-west-2"]
}

variable "enable_budget" {
  description = "Create a monthly AWS cost budget."
  type        = bool
  default     = false
}

variable "monthly_budget_usd" {
  description = "Monthly budget limit in USD."
  type        = number
  default     = 10
}

variable "github_repository" {
  description = "GitHub owner/repository allowed to assume the optional deploy role."
  type        = string
  default     = "REPLACE_ME_OWNER/job-scout"
}

variable "enable_github_oidc" {
  description = "Create a GitHub Actions OIDC provider and deployment role. Bootstrap this once with trusted credentials."
  type        = bool
  default     = false
}

variable "terraform_state_bucket_name" {
  description = "Existing S3 state bucket the optional GitHub deploy role may access."
  type        = string
  default     = "REPLACE_ME-job-scout-terraform-state"
}

