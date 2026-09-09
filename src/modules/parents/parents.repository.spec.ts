import { ParentsRepository } from './parents.repository';

describe('ParentsRepository', () => {
  it('findByEmailWithChildren looks up the parent by email with children joined', async () => {
    const findUnique = jest.fn().mockResolvedValue({ id: 'p1', children: [] });
    const repo = new ParentsRepository({ parent: { findUnique } } as never);

    await expect(
      repo.findByEmailWithChildren('a@example.com'),
    ).resolves.toEqual({ id: 'p1', children: [] });
    expect(findUnique).toHaveBeenCalledWith({
      where: { email: 'a@example.com' },
      include: { children: true },
    });
  });
});
