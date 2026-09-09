import { ParentsController } from './parents.controller';

describe('ParentsController', () => {
  it('lookup() delegates to the service', async () => {
    const service = { lookup: jest.fn().mockResolvedValue({ parentId: 'p1' }) };
    const controller = new ParentsController(service as never);
    const dto = { email: 'a@example.com' } as never;

    await expect(controller.lookup(dto)).resolves.toEqual({ parentId: 'p1' });
    expect(service.lookup).toHaveBeenCalledWith(dto);
  });
});
