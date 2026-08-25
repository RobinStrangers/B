type D1BindValue = string | number | null;

type RemoteD1Query = {
  sql: string;
  params?: D1BindValue[];
};

type RemoteD1Result = {
  meta?: Record<string, unknown> & { changes?: number };
  results?: Record<string, unknown>[];
  success?: boolean;
};

type RemoteD1Response = {
  success?: boolean;
  result?: RemoteD1Result[];
  errors?: Array<{ message?: string }>;
  messages?: Array<{ message?: string }>;
};

export class DatabaseUnavailableError extends Error {
  constructor(message = 'The Aventa database is unavailable.') {
    super(message);
    this.name = 'DatabaseUnavailableError';
  }
}

function environmentValue(name: string) {
  return process.env[name]?.trim() || '';
}

function normalizeBindValue(value: unknown): D1BindValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return value.toString();
  throw new TypeError(`Unsupported D1 bind value: ${typeof value}`);
}

function databaseConfiguration() {
  const accountId = environmentValue('CLOUDFLARE_ACCOUNT_ID');
  const databaseId = environmentValue('CLOUDFLARE_D1_DATABASE_ID');
  const apiToken = environmentValue('CLOUDFLARE_D1_API_TOKEN');

  const missing = [
    !accountId && 'CLOUDFLARE_ACCOUNT_ID',
    !databaseId && 'CLOUDFLARE_D1_DATABASE_ID',
    !apiToken && 'CLOUDFLARE_D1_API_TOKEN',
  ].filter(Boolean) as string[];

  if (missing.length) {
    throw new DatabaseUnavailableError(
      `The Aventa database is not configured. Missing ${missing.join(', ')}.`,
    );
  }

  return {
    endpoint: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
    apiToken,
  };
}

function remoteErrorMessage(payload: RemoteD1Response | null, status: number) {
  const messages = [
    ...(payload?.errors ?? []),
    ...(payload?.messages ?? []),
  ]
    .map((entry) => entry.message?.trim())
    .filter((message): message is string => Boolean(message));

  return messages.join('; ') || `Cloudflare D1 returned HTTP ${status}.`;
}

class RestD1PreparedStatement {
  constructor(
    private readonly database: RestD1Database,
    readonly sql: string,
    readonly params: D1BindValue[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new RestD1PreparedStatement(
      this.database,
      this.sql,
      values.map(normalizeBindValue),
    ) as unknown as D1PreparedStatement;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const result = await this.database.execute({ sql: this.sql, params: this.params });
    return (result.results?.[0] as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return await this.database.execute({ sql: this.sql, params: this.params }) as unknown as D1Result<T>;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return await this.database.execute({ sql: this.sql, params: this.params }) as unknown as D1Result<T>;
  }

  async raw<T extends unknown[] = unknown[]>(): Promise<T[]> {
    const result = await this.database.execute({ sql: this.sql, params: this.params });
    return (result.results ?? []).map((row) => Object.values(row) as T);
  }
}

class RestD1Database {
  prepare(sql: string): D1PreparedStatement {
    return new RestD1PreparedStatement(this, sql) as unknown as D1PreparedStatement;
  }

  async execute(query: RemoteD1Query): Promise<RemoteD1Result> {
    const [result] = await this.request(query);
    if (!result) throw new DatabaseUnavailableError('Cloudflare D1 returned no query result.');
    return result;
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const batch = statements.map((statement) => {
      if (!(statement instanceof RestD1PreparedStatement)) {
        throw new TypeError('Aventa received a database statement from an unsupported adapter.');
      }
      return {
        sql: statement.sql,
        ...(statement.params.length ? { params: statement.params } : {}),
      };
    });

    if (!batch.length) return [];
    return await this.request({ batch }) as unknown as D1Result<T>[];
  }

  private async request(
    body: RemoteD1Query | { batch: RemoteD1Query[] },
  ): Promise<RemoteD1Result[]> {
    const { endpoint, apiToken } = databaseConfiguration();

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      throw new DatabaseUnavailableError('Cloudflare D1 could not be reached.');
    }

    let payload: RemoteD1Response | null = null;
    try {
      payload = await response.json() as RemoteD1Response;
    } catch {
      throw new DatabaseUnavailableError(`Cloudflare D1 returned HTTP ${response.status} with an invalid response.`);
    }

    const results = payload.result ?? [];
    const failedResult = results.find((result) => result.success === false);

    if (!response.ok || payload.success === false || failedResult) {
      throw new DatabaseUnavailableError(remoteErrorMessage(payload, response.status));
    }

    return results;
  }
}

let cachedDatabase: D1Database | undefined;

export function getDatabase(): D1Database {
  // Validate configuration lazily so `next build` can evaluate modules without
  // requiring production secrets. Runtime API calls still fail closed when the
  // database credentials are absent.
  databaseConfiguration();
  cachedDatabase ??= new RestD1Database() as unknown as D1Database;
  return cachedDatabase;
}
