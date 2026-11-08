# Cost and security

## Cost model

The defaults target a small personal workload: six scheduled runs per day,
one Lambda invocation per run, on-demand DynamoDB, short Bedrock prompts, one
digest per run, and modest logs. Actual cost is driven primarily by Bedrock
input/output tokens and collector volume, not the scheduler.

The examples use a USD 10 development budget and USD 25 production budget.
Budgets notify at 80% forecast and 100% actual, but alerts can lag usage and do
not cap or stop spending. AWS Budgets itself, CloudWatch logs/alarms, SES,
DynamoDB backups, data transfer, and model pricing should be checked against
current regional pricing before deployment. Cross-region inference may process
requests in any region represented by the configured profile.

Each evaluation persists Bedrock input/output token counts and an estimated
cost. The estimate uses `BEDROCK_INPUT_COST_PER_MILLION` and
`BEDROCK_OUTPUT_COST_PER_MILLION` (example defaults: USD 1 and USD 5). These
are assumptions, not quoted prices; update them from the current AWS price
page before relying on estimates. Evaluation cache keys include content,
profile, scoring, and model versions.

Cost controls:

- Keep the schedule disabled during setup and incidents.
- Enforce each marketplace's persisted polling interval, page limit, and
  request cap. Remotive is limited to one request every six hours. Adzuna and
  Jooble quotas depend on the account and must be reviewed before enabling.
- Keep prompts and requested output bounded.
- Enforce the configured jobs, requests, runtime, and Bedrock-call caps.
- Skip Bedrock and SES when there are no new jobs.
- Apply TTL to disposable records and explicit log retention.
- Use DynamoDB on-demand until measured traffic justifies provisioned capacity.
- Enable the optional budget and monitor service usage separately.

## Security controls

- No long-lived AWS keys are stored in GitHub; deployment uses OIDC.
- GitHub deployment is manual and protected by environment reviewers.
- Runtime and scheduler roles are separate and least-privilege.
- SES is restricted to one verified sender resource and one recipient.
- Bedrock invocation is restricted to the named cross-region inference profile
  and explicit foundation-model ARNs in its US destinations.
- DynamoDB is encrypted, point-in-time recovery and deletion protection default
  on, and access is scoped to one table and its indexes.
- Terraform/provider versions are exact pins. Review upgrades intentionally.
- Secrets and credentials must never be placed in source, YAML, committed
  tfvars, logs, job content, or Terraform outputs. Supply optional marketplace
  credentials through protected runtime environment configuration or Secrets
  Manager; remember that Terraform-managed Lambda environment values are
  present in encrypted Terraform state.

The notification and sender addresses are configuration, not authentication
secrets, but GitHub environment secrets reduce accidental exposure in logs and
workflow metadata. Terraform state can still contain sensitive configuration;
use encrypted remote state, locking, versioning, least-privilege access, and
audit logging.

## Residual risks

Collectors process untrusted remote content. The application should cap
response size and time, validate URLs, prevent internal/link-local network
access, escape email output, and treat scraped text as untrusted model input.
Model output must not authorize companies, execute code, or trigger deployment.

Cross-region Bedrock inference expands the data-processing region set. Confirm
that job text and prompts are permitted in every destination region. Do not put
candidate secrets or unnecessary personal data in prompts, logs, or records.

At-least-once invocation means duplicate email remains possible. DynamoDB
conditional writes are the preferred deduplication boundary, but they cannot
prove an SES message was not accepted immediately before a failure.
