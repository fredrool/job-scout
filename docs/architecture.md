# Architecture

## Runtime flow

1. EventBridge Scheduler invokes the Lambda every four hours when the schedule
   is enabled.
2. The Node.js 22 Lambda loads only approved, enabled companies from the
   application registry. An empty registry, or one containing only disabled
   entries, is a valid no-op and yields no jobs.
3. Collectors fetch job listings, verify official HTTP(S) source URLs, and
   normalize stable identifiers and content hashes.
4. Deterministic filters classify Quebec eligibility as `CONFIRMED`,
   `POSSIBLE`, or `INELIGIBLE`, reject ineligible jobs, and compute an
   explainable weighted score. Only plausible candidates reach Bedrock.
5. DynamoDB provides deduplication, run state, and query access through one
   table with `PK`/`SK` and three sparse GSIs for status/pending claims,
   company/discovery time, and user score.
6. Bedrock Converse evaluates candidates through the US cross-region
   inference profile
   `us.anthropic.claude-haiku-4-5-20251001-v1:0`.
7. Qualifying versions become durable pending notification records. A
   conditional batch claim sends up to the configured digest limit; overflow
   remains pending for a later run.
8. SES sends the digest from the configured sender to the single configured
   notification recipient.
9. CloudWatch retains Lambda logs and alarms on errors and throttles.

The schedule starts disabled. It uses two retries, so a run is delivered
at least once rather than exactly once.

## Data model and lifecycle

The infrastructure declares string keys only; item shapes remain owned by the
application. The three sparse GSIs support alternate access patterns without
requiring every item to be indexed. `expiresAt` is a DynamoDB TTL attribute.
TTL deletion is asynchronous and is not a precise deletion deadline.

Entity prefixes include `JOB#provider#canonicalId`, `EVAL#cacheKey`,
`FEEDBACK#userId`, `NOTIFY#userId`, `BATCH#userId`, and `LOCK#SCAN`.
Discovery records are reusable; profile, score, feedback, batch, and
notification records carry a `userId` boundary for a future migration. The MVP
uses only `default` and has no authentication or multi-user management.

The table uses on-demand billing, AWS-owned encryption at rest, point-in-time
recovery by default, and deletion protection by default. CloudWatch log
retention defaults to 30 days (90 in the production example). Terraform state
contains resource metadata and must be encrypted and access-controlled.

## Trust boundaries

- The Lambda role can write only its log group, access the Job Scout table and
  indexes, invoke the named inference profile and its explicit US destination
  model ARNs, and send from the configured SES identity to the configured
  recipient.
- The Scheduler role can invoke only the Job Scout Lambda.
- GitHub Actions receives short-lived AWS credentials through OIDC. Its trust
  policy is restricted to one repository and one protected environment.
- The deploy role is intended for this stack, not application runtime. Some AWS
  control-plane actions do not support resource-level constraints; those
  actions use `Resource: "*"` while the role itself is environment-scoped.

## Reliability limitations

EventBridge retries, Lambda retries/timeouts, and failures after SES accepts a
message can result in duplicate notifications. DynamoDB conditional writes can
reduce duplicates, but SES `SendEmail` has no general idempotency token.
Recipients must tolerate duplicate digests. CloudWatch alarms have no action
configured by default; attach an approved notification channel separately.
