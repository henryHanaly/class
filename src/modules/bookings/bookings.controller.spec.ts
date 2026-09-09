import { BookingsController } from './bookings.controller';

describe('BookingsController', () => {
  const service = { create: jest.fn(), getById: jest.fn() };
  const controller = new BookingsController(service as never);

  afterEach(() => jest.clearAllMocks());

  it('create() forwards the dto and the request id to the service', async () => {
    service.create.mockResolvedValue({ bookingId: 'b1' });
    const dto = { parentId: 'p', childId: 'c', classId: 'cl' } as never;

    const res = await controller.create(dto, { id: 'req-1' } as never);

    expect(res).toEqual({ bookingId: 'b1' });
    expect(service.create).toHaveBeenCalledWith(dto, { requestId: 'req-1' });
  });

  it('get() delegates to the service by id', async () => {
    service.getById.mockResolvedValue({ bookingId: 'b1', status: 'confirmed' });

    await expect(controller.get('b1')).resolves.toEqual({
      bookingId: 'b1',
      status: 'confirmed',
    });
    expect(service.getById).toHaveBeenCalledWith('b1');
  });
});
