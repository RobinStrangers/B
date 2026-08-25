type BrowserLoggerOptions = {
  level?: keyof typeof levels.values;
  browser?: { write?: (entry: string) => void };
};

type LogWriter = { write?: (entry: string) => void };
type LogMethod = (...values: unknown[]) => void;

export const levels = {
  values: {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60,
    silent: Number.POSITIVE_INFINITY,
  },
} as const;

function serialize(level: number, bindings: Record<string, unknown>, values: unknown[]) {
  const first = values[0];
  const fields = first && typeof first === 'object' && !Array.isArray(first)
    ? first as Record<string, unknown>
    : {};
  const messageValue = typeof first === 'string' ? first : values.find((value) => typeof value === 'string');
  return JSON.stringify({
    level,
    time: Date.now(),
    ...bindings,
    ...fields,
    ...(messageValue ? { msg: messageValue } : {}),
  });
}

export function pino(options: BrowserLoggerOptions = {}, destination?: LogWriter) {
  const threshold = levels.values[options.level ?? 'info'];
  const createLogger = (bindings: Record<string, unknown> = {}) => {
    const logger = {} as Record<string, unknown>;
    const attach = (name: keyof typeof levels.values) => {
      const value = levels.values[name];
      logger[name] = ((...values: unknown[]) => {
        if (value < threshold || name === 'silent') return;
        const entry = serialize(value, bindings, values);
        options.browser?.write?.(entry);
        destination?.write?.(entry);
      }) as LogMethod;
    };
    (Object.keys(levels.values) as Array<keyof typeof levels.values>).forEach(attach);
    logger.child = (childBindings: Record<string, unknown> = {}) => createLogger({ ...bindings, ...childBindings });
    logger.bindings = () => ({ ...bindings });
    logger.flush = () => undefined;
    logger.level = options.level ?? 'info';
    logger.levels = levels;
    return logger;
  };
  return createLogger();
}

export default pino;
