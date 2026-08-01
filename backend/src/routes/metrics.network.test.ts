import {
  computeNetworkRates,
  parseProcNetDev,
} from './metrics';

const PROC_NET_DEV_FIXTURE = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 4837211   31200    0    0    0     0          0         0  4837211   31200    0    0    0     0       0          0
  eth0: 981234567  812345    0    0    0     0          0      1200  456789012  512345    0    0    0     0       0          0
docker0:  8123456   61234    0    0    0     0          0         0   9123456   71234    0    0    0     0       0          0
veth1a2b:  123456    1000    0    0    0     0          0         0    223456    2000    0    0    0     0       0          0
br-9f8e:   34567     300    0    0    0     0          0         0     44567     400    0    0    0     0       0          0
tailscale0: 555555    5000    0    0    0     0          0         0    666666    6000    0    0    0     0       0          0
  ens5: 1000000    9999    0    0    0     0          0         0   2000000    8888    0    0    0     0       0          0
`;

describe('parseProcNetDev', () => {
  it('sums physical interfaces and excludes loopback, virtual, and tunnel devices', () => {
    const sample = parseProcNetDev(PROC_NET_DEV_FIXTURE);
    expect(sample).not.toBeNull();
    // eth0 + ens5 only.
    expect(sample!.rxBytes).toBe(981234567 + 1000000);
    expect(sample!.txBytes).toBe(456789012 + 2000000);
  });

  it('returns null when no countable interface exists', () => {
    const loopbackOnly = [
      'Inter-|   Receive |  Transmit',
      ' face |bytes    packets|bytes    packets',
      '    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0',
    ].join('\n');
    expect(parseProcNetDev(loopbackOnly)).toBeNull();
  });

  it('returns null for unreadable content', () => {
    expect(parseProcNetDev('')).toBeNull();
    expect(parseProcNetDev('garbage without any device rows')).toBeNull();
  });

  it('skips rows with non-numeric counters without discarding valid rows', () => {
    const mixed = [
      '  eth0: not-a-number 0 0 0 0 0 0 0 xyz 0 0 0 0 0 0 0',
      '  eth1: 1000 1 0 0 0 0 0 0 2000 2 0 0 0 0 0 0',
    ].join('\n');
    const sample = parseProcNetDev(mixed);
    expect(sample).toEqual({ rxBytes: 1000, txBytes: 2000 });
  });
});

describe('computeNetworkRates', () => {
  const base = { atMs: 1_000_000, rxBytes: 10_000, txBytes: 5_000 };

  it('computes bytes-per-second rates from counter deltas', () => {
    const rates = computeNetworkRates(base, {
      atMs: base.atMs + 30_000,
      rxBytes: base.rxBytes + 3_000_000,
      txBytes: base.txBytes + 600_000,
    });
    expect(rates.available).toBe(true);
    expect(rates.inBytesPerSecond).toBeCloseTo(100_000);
    expect(rates.outBytesPerSecond).toBeCloseTo(20_000);
  });

  it('reports unavailable instead of a spike on counter reset', () => {
    const rates = computeNetworkRates(base, {
      atMs: base.atMs + 30_000,
      rxBytes: 100,
      txBytes: 50,
    });
    expect(rates).toEqual({ inBytesPerSecond: 0, outBytesPerSecond: 0, available: false });
  });

  it('reports unavailable for sub-second sampling windows', () => {
    const rates = computeNetworkRates(base, {
      atMs: base.atMs + 500,
      rxBytes: base.rxBytes + 1_000,
      txBytes: base.txBytes + 1_000,
    });
    expect(rates.available).toBe(false);
  });

  it('reports a genuine zero rate as available on an idle link', () => {
    const rates = computeNetworkRates(base, {
      atMs: base.atMs + 30_000,
      rxBytes: base.rxBytes,
      txBytes: base.txBytes,
    });
    expect(rates).toEqual({ inBytesPerSecond: 0, outBytesPerSecond: 0, available: true });
  });
});
