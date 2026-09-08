import { ParentNotFoundError } from '../../common/errors/parent-not-found.error';
import { ParentsService } from './parents.service';

function setup() {
  const repo = { findByEmailWithChildren: jest.fn() };
  const service = new ParentsService(repo as never);
  return { service, repo };
}

describe('ParentsService.lookup', () => {
  it('throws ParentNotFoundError for an unseeded email', async () => {
    const { service, repo } = setup();
    repo.findByEmailWithChildren.mockResolvedValue(null);

    await expect(
      service.lookup({ email: 'nobody@example.com' }),
    ).rejects.toBeInstanceOf(ParentNotFoundError);
  });

  it('maps parent + children, hiding internal columns', async () => {
    const { service, repo } = setup();
    repo.findByEmailWithChildren.mockResolvedValue({
      id: 'p1',
      name: 'Alice',
      email: 'alice@example.com',
      children: [{ id: 'c1', name: 'Amy', grade: 'P3', parentId: 'p1' }],
    });

    const res = await service.lookup({ email: 'alice@example.com' });

    expect(res).toEqual({
      parentId: 'p1',
      name: 'Alice',
      children: [{ id: 'c1', name: 'Amy', grade: 'P3' }],
    });
    expect(res.children[0]).not.toHaveProperty('parentId');
  });
});
