import { ClassNotFoundError } from '../../common/errors/class-not-found.error';
import { TrialClassesService } from './trial-classes.service';

function setup() {
  const repo = {
    listUpcomingWithSeatsLeft: jest.fn(),
    findById: jest.fn(),
    listConfirmedRoster: jest.fn(),
  };
  const service = new TrialClassesService(repo as never);
  return { service, repo };
}

describe('TrialClassesService.listUpcoming', () => {
  it('maps rows and clamps seatsLeft to zero', async () => {
    const { service, repo } = setup();
    const startsAt = new Date('2026-05-01T10:00:00.000Z');
    repo.listUpcomingWithSeatsLeft.mockResolvedValue([
      { id: 'cl1', subject: 'Math', starts_at: startsAt, capacity: 4, price_cents: 2500, seats_left: 3 },
      { id: 'cl2', subject: 'Sci', starts_at: startsAt, capacity: 4, price_cents: 3000, seats_left: -1 },
    ]);

    const res = await service.listUpcoming();

    expect(res[0]).toEqual({
      id: 'cl1',
      subject: 'Math',
      startsAt: startsAt.toISOString(),
      capacity: 4,
      seatsLeft: 3,
      priceCents: 2500,
    });
    expect(res[1].seatsLeft).toBe(0);
  });
});

describe('TrialClassesService.getRoster', () => {
  it('throws ClassNotFoundError for an unknown class', async () => {
    const { service, repo } = setup();
    repo.findById.mockResolvedValue(null);

    await expect(service.getRoster('missing')).rejects.toBeInstanceOf(
      ClassNotFoundError,
    );
  });

  it('returns only confirmed students, mapped', async () => {
    const { service, repo } = setup();
    const bookedAt = new Date('2026-05-01T09:00:00.000Z');
    repo.findById.mockResolvedValue({ id: 'cl1', subject: 'Math' });
    repo.listConfirmedRoster.mockResolvedValue([
      { child_id: 'c1', name: 'Amy', grade: 'P3', booked_at: bookedAt },
    ]);

    await expect(service.getRoster('cl1')).resolves.toEqual({
      classId: 'cl1',
      subject: 'Math',
      students: [
        { childId: 'c1', name: 'Amy', grade: 'P3', bookedAt: bookedAt.toISOString() },
      ],
    });
  });
});
