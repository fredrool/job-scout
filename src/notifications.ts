import { Injectable } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { NotificationBatch } from './storage.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function safeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Notification link must be HTTP(S)');
  }
  return url.toString();
}

export interface RenderedDigest {
  subject: string;
  html: string;
  text: string;
}

@Injectable()
export class DigestRenderer {
  render(batch: NotificationBatch, timezone: string): RenderedDigest {
    const date = new Intl.DateTimeFormat('en-CA', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(new Date());
    const htmlJobs = batch.items.map((item) => {
      const { match, evaluation } = item;
      const sourceUrl = safeUrl(match.job.sourceUrl);
      const applyUrl = safeUrl(match.job.applyUrl);
      const warning =
        match.remoteEligibility === 'POSSIBLE'
          ? '<p style="color:#9a6700"><strong>Eligibility requires verification:</strong> Canada/Quebec was not explicitly confirmed.</p>'
          : '';
      const sourceLabel =
        match.job.provider === 'adzuna'
          ? `<a href="${escapeHtml(sourceUrl)}" style="display:inline-block;min-width:116px;min-height:23px">Jobs by Adzuna</a>`
          : escapeHtml(match.job.sourceName ?? match.job.provider);
      return `<article style="border:1px solid #ddd;border-radius:8px;padding:16px;margin:16px 0">
<h2>${escapeHtml(match.job.title)} — ${escapeHtml(match.job.companyName ?? match.job.companyId)}</h2>
<p><strong>Match:</strong> ${String(match.score)}/100 — ${escapeHtml(match.reasons.join('; ') || evaluation.evaluation.recommendation)}</p>
<p><strong>Source:</strong> ${sourceLabel}${match.job.sourceKind === 'MARKETPLACE' ? ' (marketplace listing)' : ' (original employer board)'}</p>
<p><strong>Remote eligibility:</strong> ${match.remoteEligibility}</p>${warning}
<p><strong>Salary:</strong> ${escapeHtml(match.salary ?? 'Unknown')}</p>
<p><strong>Potential gaps:</strong> ${escapeHtml(match.gaps.join('; ') || 'None identified')}</p>
<p><strong>Discovered:</strong> ${escapeHtml(match.job.firstSeenAt ?? item.createdAt)}</p>
<p><a href="${escapeHtml(sourceUrl)}"><strong>View Job / Apply</strong></a>${
        applyUrl !== sourceUrl ? ` · <a href="${escapeHtml(applyUrl)}">Direct application</a>` : ''
      }</p>
</article>`;
    });
    const textJobs = batch.items.map((item) => {
      const { match, evaluation } = item;
      return [
        `${match.job.title} — ${match.job.companyName ?? match.job.companyId}`,
        `Match: ${String(match.score)}/100 — ${match.reasons.join('; ') || evaluation.evaluation.recommendation}`,
        `Source: ${match.job.sourceName ?? match.job.provider}${match.job.sourceKind === 'MARKETPLACE' ? ' (marketplace listing)' : ' (original employer board)'}`,
        `Remote eligibility: ${match.remoteEligibility}${match.remoteEligibility === 'POSSIBLE' ? ' — Canada/Quebec eligibility requires verification' : ''}`,
        `Salary: ${match.salary ?? 'Unknown'}`,
        `Potential gaps: ${match.gaps.join('; ') || 'None identified'}`,
        `Discovered: ${match.job.firstSeenAt ?? item.createdAt}`,
        `View Job / Apply: ${safeUrl(match.job.sourceUrl)}`,
        ...(match.job.applyUrl !== match.job.sourceUrl
          ? [`Direct application: ${safeUrl(match.job.applyUrl)}`]
          : []),
      ].join('\n');
    });
    return {
      subject: `Job Scout: ${String(batch.items.length)} new match${batch.items.length === 1 ? '' : 'es'}`,
      html: `<!doctype html><html><body style="font-family:Arial,sans-serif;max-width:760px;margin:auto"><h1>Job Scout</h1><p>${escapeHtml(date)}</p>${htmlJobs.join('')}</body></html>`,
      text: `Job Scout — ${date}\n\n${textJobs.join('\n\n---\n\n')}`,
    };
  }
}

@Injectable()
export class SesNotificationService {
  constructor(
    private readonly client: SESv2Client,
    private readonly renderer: DigestRenderer,
    private readonly sender: string,
    private readonly timezone: string,
  ) {}

  async send(batch: NotificationBatch, recipient: string): Promise<string> {
    const email = this.renderer.render(batch, this.timezone);
    const response = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.sender,
        Destination: { ToAddresses: [recipient] },
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: email.html, Charset: 'UTF-8' },
              Text: { Data: email.text, Charset: 'UTF-8' },
            },
          },
        },
      }),
    );
    if (!response.MessageId) throw new Error('SES accepted no message ID');
    return response.MessageId;
  }
}
