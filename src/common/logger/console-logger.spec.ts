import { ConsoleLogger } from './console-logger';

describe('ConsoleLogger', () => {
  let write: jest.SpyInstance;

  beforeEach(() => {
    write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => write.mockRestore());

  it.each(['info', 'warn', 'error', 'debug'] as const)(
    'writes one structured JSON line for %s',
    (level) => {
      new ConsoleLogger()[level]('some.event', { requestId: 'r1' });

      expect(write).toHaveBeenCalledTimes(1);
      const line = write.mock.calls[0][0] as string;
      expect(line.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(line);
      expect(parsed).toMatchObject({ level, event: 'some.event', requestId: 'r1' });
      expect(typeof parsed.ts).toBe('string');
    },
  );
});
