# Operations runbook

## Company approval workflow

Treat the company registry as an allowlist:

1. Open a reviewed change describing the company, official careers URL,
   collector method, expected request rate, and authorization/terms review.
2. Add the company disabled.
3. Validate parsing against saved fixtures or an explicitly authorized local
   request. Never bypass access controls, CAPTCHAs, or site rate limits.
4. Run `npm run cli -- companies list`, then explicitly probe approved enabled
   boards with `npm run cli -- companies health`.
5. Obtain owner approval and enable the company in a second reviewed change.
6. Watch the first run's logs and disable the company on repeated errors,
   unexpected volume, site changes, or a removal request.

An empty company registry disables only secondary ATS discovery. Marketplace
providers in `config/job-boards.yaml` remain the primary discovery mechanism.

The built-in URL recognizer does not search the web or automatically discover
new employers. Automatic employer discovery requires a separately configured,
legitimate `CompanyDiscoverySource`; every candidate still requires review.

## Marketplace provider workflow

1. Review `config/job-boards.yaml`, current provider terms, attribution, and
   account quota.
2. Use `npm run cli -- providers test remotive` without credentials.
3. Set Adzuna credentials only in the local environment or protected
   deployment secrets, then run `npm run cli -- providers test adzuna`.
4. Use `npm run cli -- providers test-all` to report each enabled source
   independently. A failed provider must not suppress successful providers.
5. Keep Jooble disabled until a region-specific key and its lifetime quota are
   approved. Never commit keys to YAML, examples, or tfvars.

Remotive public API data is delayed and must be attributed. Job Scout enforces
a minimum six-hour polling interval and one request per poll. Provider polling
timestamps and failures are persisted in DynamoDB. Marketplace searches are
bounded and are never used as authoritative evidence that a previously seen
job expired.

## Pre-deployment checklist

1. Run `node scripts/deploy-prep.mjs`.
2. Replace all tfvars placeholders and review `terraform plan`.
3. Verify the SES sender identity. While the account is in the SES sandbox,
   verify the notification recipient too; sandbox sending and daily/rate quotas
   still apply. Request production access before sending to unverified
   recipients.
4. Confirm Anthropic model access and cross-region inference are allowed by the
   account and organization policies in all configured destination regions.
5. Perform one authorized, low-token Bedrock Converse preflight using the exact
   inference-profile ID. This is a live, billable API call and is intentionally
   not run by CI or setup:

   ```sh
   aws bedrock-runtime converse \
     --region us-east-1 \
     --model-id us.anthropic.claude-haiku-4-5-20251001-v1:0 \
     --messages '[{"role":"user","content":[{"text":"Reply with OK."}]}]' \
     --inference-config '{"maxTokens":4,"temperature":0}'
   ```

6. Invoke the Lambda once with the schedule still disabled. Check logs, table
   writes, model behavior, and the expected recipient.
7. Enable `schedule_enabled` only through a reviewed Terraform change.

AWS CLI JSON quoting differs in PowerShell. Place the two JSON values in files
and use `file://path.json` if necessary.

## GitHub deployment setup

Bootstrap OIDC once with trusted AWS credentials by setting
`enable_github_oidc = true` and the exact `github_repository`. This bootstrap
is not performed by CI. Put the resulting role ARN in each matching GitHub
environment as `AWS_ROLE_ARN`.

Create protected `dev` and `prod` environments, configure required reviewers,
restrict deployment branches, and add `NOTIFICATION_EMAIL` and `SENDER_EMAIL`
environment secrets. Add the `TF_STATE_BUCKET` variable,
optionally `AWS_REGION`, and keep `SCHEDULE_ENABLED` set to `false` until the
pre-deployment checklist passes. The manual Deploy workflow cannot obtain
environment secrets or an OIDC token for that environment until approval.

If using remote state, provision the encrypted versioned S3 bucket first,
copy `backend.tf.example`, enable native S3 lockfiles, and restrict state access
to deployers.

## Incidents

- **Collector failures:** disable the affected company; do not increase retries
  until rate limits and terms are reviewed.
- **Lambda errors/throttles:** inspect `/aws/lambda/job-scout-ENV`, compare the
  run ID with DynamoDB state, and avoid blind manual retries.
- **No email:** check that jobs existed, both SES identities are verified when
  sandboxed, quotas are available, and the IAM recipient condition matches.
- **Duplicate email:** expected under at-least-once delivery. Check whether the
  run timed out after SES accepted the message.
- **Model denied:** verify model availability, profile destinations,
  organization SCPs, marketplace/model access prerequisites, and the role
  policy before changing IAM.
- **Unexpected spend:** disable the schedule first, then inspect Lambda
  invocation count, Bedrock token usage, DynamoDB requests, and log ingestion.

## Retention, deletion, and recovery

- DynamoDB TTL removes only items carrying `expiresAt`, asynchronously.
- Point-in-time recovery is enabled by default; set a deliberate backup policy
  for retention beyond its recovery window.
- Log groups retain data for the configured number of days.
- Removing a company should include deletion or expiry of company-specific
  records where policy requires it.
- `terraform destroy` permanently removes compute and, after deletion
  protection is explicitly disabled, the DynamoDB table and its data. Export
  or back up required data first. Destroying SES/IAM/scheduling resources can
  also interrupt recovery procedures.
