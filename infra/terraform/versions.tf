terraform {
  required_version = ">= 1.10.5, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 5.82.2"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Application = "job-scout"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
