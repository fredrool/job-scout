# Job Scout

Job Scout is a scheduled AWS Lambda application that searches multi-employer
job marketplaces first, supplements them with explicit employer ATS boards,
ranks normalized jobs with Amazon Bedrock, stores state in DynamoDB, and sends
a digest with Amazon SES.

This repository contains deployment-ready infrastructure and automation, but
nothing in it deploys automatically. The schedule defaults to disabled.

## Local development

Requirements:

- Node.js 22 and npm
- Terraform 1.10.5
- AWS CLI v2 only when performing an authorized preflight or deployment

Install and run the application checks:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run cli -- --help
npm run package
```

Copy `.env.example` to `.env` (or export the values through your shell).
`NOTIFICATION_EMAIL` and `SENDER_EMAIL` are configuration only and are never
read from the profile. Useful local commands:

```sh
npm run cli -- companies validate
npm run cli -- companies list
npm run cli -- companies discover "Example Inc" https://jobs.example.com
npm run cli -- companies add example-inc "Example Inc" greenhouse https://boards.greenhouse.io/example example
npm run cli -- companies add-file company.yaml
npm run cli -- companies enable example-inc
npm run cli -- companies health
npm run cli -- providers test remotive
npm run cli -- providers test adzuna
npm run cli -- providers test-all
npm run cli -- scan dry-run
npm run cli -- feedback JOB_ID interested
```

New companies are always added disabled. Review terms, ownership, board token,
and a fixture before enabling one. `companies list` reports configured active
sources without network access; `companies health` explicitly probes enabled
boards and reports completeness, latency, job count, and errors.

The built-in `companies discover` command recognizes a career URL supplied by
the operator. Job Scout cannot automatically find new employers unless a
legitimate search provider implementing `CompanyDiscoverySource` is configured.
Discovery candidates always require manual approval and are never auto-enabled.

## Marketplace discovery

`config/job-boards.yaml` independently controls Adzuna, Remotive, and Jooble,
including role families, countries/regions, polling intervals, page limits,
and request caps. The default strategy searches senior full-stack, software,
frontend/React, Node/Java backend, product, platform, staff/architecture, and
applied-AI integration roles.

- Adzuna is enabled but skipped until `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` are
  supplied through the environment or protected Terraform/GitHub variables.
  Results link through Adzuna and retain the required attribution.
- Remotive is enabled without credentials. It is fetched at most once every
  six hours, never more than its documented recommendation of four times per
  day, and every listing is labeled and linked to Remotive.
- Jooble is implemented but disabled. Enable it only after obtaining the
  correct regional key, confirming its lifetime/request quota, and setting
  `JOOBLE_API_KEY`.

Credentials are never stored in YAML. A missing optional credential reports a
source health warning and does not prevent Job Scout or other providers from
running. Do not add LinkedIn or Indeed scraping without authorized API access.
Review each provider's current API terms, attribution rules, and account quota
before enabling production polling.

The packaging command must produce
`.artifacts/job-scout-lambda.zip`. `scripts/package-lambda.mjs` is the
dependency-free deterministic ZIP utility for a built `dist/lambda` directory:

```sh
node scripts/package-lambda.mjs dist/lambda .artifacts/job-scout-lambda.zip
```

Run all deployment preparation checks without changing AWS:

```sh
node scripts/deploy-prep.mjs
```

## Terraform

Copy an example and replace every placeholder:

```sh
cd infra/terraform
cp dev.tfvars.example dev.tfvars
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
terraform plan -var-file=dev.tfvars
```

`plan` reads the Lambda ZIP, so package first. Do not enable the schedule until
marketplace terms/credentials, company boards, model access, and SES identities
have been checked. An empty company registry disables only secondary ATS
discovery; enabled marketplaces continue searching.

Safe manual invocation and logs:

```sh
aws lambda invoke --region us-east-1 --function-name job-scout-dev response.json
aws logs tail /aws/lambda/job-scout-dev --follow --since 1h
```

To remove the stack, first back up DynamoDB data, deliberately disable table
deletion protection, review the destroy plan, then run
`terraform destroy -var-file=dev.tfvars`. This permanently deletes findings,
feedback, evaluation cache, and notification history.

Remote state is optional. Copy `backend.tf.example` to `backend.tf`, replace
its placeholders, and bootstrap its encrypted, versioned S3 bucket outside
this stack before initializing. Terraform's native S3 lockfile is enabled.

## Delivery

- `.github/workflows/ci.yml` runs application checks, packaging, Terraform
  formatting, and validation.
- `.github/workflows/deploy.yml` is manual-only, uses GitHub OIDC (no static AWS
  keys), and is gated by a protected `dev` or `prod` GitHub environment.
- Configure required reviewers on both GitHub environments. Set environment
  variables `AWS_ROLE_ARN`, `TF_STATE_BUCKET`, and optionally
  `AWS_REGION` and `SCHEDULE_ENABLED`, plus secrets `NOTIFICATION_EMAIL` and
  `SENDER_EMAIL`. Add optional `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` secrets
  when Adzuna access is approved; keep `JOOBLE_API_KEY` unset while Jooble is
  disabled.

See [architecture](docs/architecture.md), the [runbook](docs/runbook.md), and
[cost and security guidance](docs/cost-security.md). No deployment or live AWS
API call has been performed by the repository setup.
