import { TrialClassesRepository } from './trial-classes.repository';

describe('TrialClassesRepository', () => {
  it('listUpcomingWithSeatsLeft runs the single seats-left query', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([{ id: 'c1' }]);
    const repo = new TrialClassesRepository({ $queryRaw } as never);

    await expect(repo.listUpcomingWithSeatsLeft()).resolves.toEqual([{ id: 'c1' }]);
    expect($queryRaw).toHaveBeenCalled();
  });

  it('findById looks the class up by id', async () => {
    const findUnique = jest.fn().mockResolvedValue({ id: 'c1', subject: 'Math' });
    const repo = new TrialClassesRepository({ trialClass: { findUnique } } as never);

    await expect(repo.findById('c1')).resolves.toEqual({ id: 'c1', subject: 'Math' });
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'c1' } });
  });

  it('listConfirmedRoster runs the roster query', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([{ child_id: 'ch1' }]);
    const repo = new TrialClassesRepository({ $queryRaw } as never);

    await expect(repo.listConfirmedRoster('c1')).resolves.toEqual([
      { child_id: 'ch1' },
    ]);
    expect($queryRaw).toHaveBeenCalled();
  });
});
