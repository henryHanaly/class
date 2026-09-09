import { TrialClassesController } from './trial-classes.controller';

describe('TrialClassesController', () => {
  const service = { listUpcoming: jest.fn(), getRoster: jest.fn() };
  const controller = new TrialClassesController(service as never);

  afterEach(() => jest.clearAllMocks());

  it('list() delegates to the service', async () => {
    service.listUpcoming.mockResolvedValue([{ id: 'c1' }]);
    await expect(controller.list()).resolves.toEqual([{ id: 'c1' }]);
  });

  it('roster() delegates to the service by id', async () => {
    service.getRoster.mockResolvedValue({ classId: 'c1', students: [] });
    await expect(controller.roster('c1')).resolves.toEqual({
      classId: 'c1',
      students: [],
    });
    expect(service.getRoster).toHaveBeenCalledWith('c1');
  });
});
