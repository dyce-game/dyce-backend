import { throttleTracker } from './throttle-tracker.ts';

const verify = (token: string) =>
  token === 'good' ? Promise.resolve({ userId: 'u-1' }) : Promise.reject(new Error('bad token'));

describe('throttleTracker', () => {
  it('counts a signed-in person by account, wherever they connect from', async () => {
    const a = await throttleTracker(
      { headers: { authorization: 'Bearer good' }, ip: '41.1.1.1' },
      verify,
    );
    const b = await throttleTracker(
      { headers: { authorization: 'Bearer good' }, ip: '41.9.9.9' },
      verify,
    );
    expect(a).toBe('user:u-1');
    expect(b).toBe(a);
  });

  it('counts everyone behind one shared address separately once they are signed in', async () => {
    const other = (token: string) => Promise.resolve({ userId: `u-${token}` });
    const x = await throttleTracker(
      { headers: { authorization: 'Bearer x' }, ip: '41.1.1.1' },
      other,
    );
    const y = await throttleTracker(
      { headers: { authorization: 'Bearer y' }, ip: '41.1.1.1' },
      other,
    );
    expect(x).not.toBe(y);
  });

  it('counts the address for anonymous requests and for tokens that do not verify', async () => {
    expect(await throttleTracker({ headers: {}, ip: '41.1.1.1' }, verify)).toBe('ip:41.1.1.1');
    expect(
      await throttleTracker(
        { headers: { authorization: 'Bearer forged' }, ip: '41.1.1.1' },
        verify,
      ),
    ).toBe('ip:41.1.1.1');
    expect(
      await throttleTracker({ headers: { authorization: 'Basic abc' }, ip: '41.1.1.1' }, verify),
    ).toBe('ip:41.1.1.1');
    expect(await throttleTracker({ headers: {} }, verify)).toBe('ip:unknown');
  });
});
