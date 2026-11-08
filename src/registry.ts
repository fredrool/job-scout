import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { parse, stringify } from 'yaml';
import {
  discoveryCandidateSchema,
  profileSchema,
  registrySchema,
  type Company,
  type CompanyRegistryDocument,
  type DiscoveryCandidate,
  type SearchProfile,
} from './domain.js';

export interface CompanyDiscoverySource {
  readonly id: string;
  readonly termsUrl: string;
  search(query: string): Promise<readonly DiscoveryCandidate[]>;
}

export class CompanyDiscoveryService {
  constructor(private readonly sources: readonly CompanyDiscoverySource[]) {}

  async search(query: string): Promise<DiscoveryCandidate[]> {
    const candidates = await Promise.all(this.sources.map((source) => source.search(query)));
    return candidates.flat().map((candidate) => discoveryCandidateSchema.parse(candidate));
  }
}

@Injectable()
export class CompanyRegistry {
  constructor(
    private readonly registryPath = join(process.cwd(), 'config', 'companies.yaml'),
    private readonly profilePath = join(process.cwd(), 'config', 'profile.yaml'),
  ) {}

  async load(): Promise<CompanyRegistryDocument> {
    return this.validate(parse(await readFile(this.registryPath, 'utf8')));
  }

  async loadProfile(): Promise<SearchProfile> {
    return profileSchema.parse(parse(await readFile(this.profilePath, 'utf8')));
  }

  validate(input: unknown): CompanyRegistryDocument {
    const registry = registrySchema.parse(input);
    const ids = new Set<string>();
    for (const company of registry.companies) {
      if (ids.has(company.id)) throw new Error(`Duplicate company id "${company.id}"`);
      ids.add(company.id);
    }
    return registry;
  }

  async add(company: Company): Promise<CompanyRegistryDocument> {
    const current = await this.load();
    if (current.companies.some((entry) => entry.id === company.id)) {
      throw new Error(`Company id "${company.id}" already exists`);
    }
    const updated = this.validate({
      companies: [...current.companies, { ...company, enabled: false }],
    });
    await this.writeAtomically(updated);
    return updated;
  }

  candidate(input: unknown): DiscoveryCandidate {
    return discoveryCandidateSchema.parse(input);
  }

  candidateFromCareersUrl(companyName: string, rawUrl: string): DiscoveryCandidate {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') throw new Error('Careers URL must use HTTPS');
    const segments = url.pathname.split('/').filter(Boolean);
    const hostname = url.hostname.toLowerCase();

    if (hostname.endsWith('greenhouse.io') && segments.at(-1)) {
      return this.candidate({
        companyName,
        careersUrl: rawUrl,
        provider: 'greenhouse',
        boardToken: segments.at(-1),
        confidence: 0.9,
        evidence: ['Recognized Greenhouse board URL'],
      });
    }
    if (hostname.endsWith('lever.co') && segments.at(-1)) {
      return this.candidate({
        companyName,
        careersUrl: rawUrl,
        provider: 'lever',
        boardToken: segments.at(-1),
        confidence: 0.9,
        evidence: ['Recognized Lever postings URL'],
      });
    }
    if (hostname.endsWith('ashbyhq.com') && segments.at(-1)) {
      return this.candidate({
        companyName,
        careersUrl: rawUrl,
        provider: 'ashby',
        boardToken: segments.at(-1),
        confidence: 0.9,
        evidence: ['Recognized Ashby job board URL'],
      });
    }
    return this.candidate({
      companyName,
      careersUrl: rawUrl,
      confidence: 0.2,
      evidence: ['HTTPS careers page requires manual provider verification'],
    });
  }

  private async writeAtomically(registry: CompanyRegistryDocument): Promise<void> {
    const temporaryPath = join(dirname(this.registryPath), `.companies-${String(process.pid)}.tmp`);
    await writeFile(
      temporaryPath,
      stringify(registry, { indent: 2, lineWidth: 100, sortMapEntries: true }),
      'utf8',
    );
    await rename(temporaryPath, this.registryPath);
  }
}
