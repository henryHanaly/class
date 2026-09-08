export class ParentLookupResponseDto {
  parentId!: string;
  name!: string;
  children!: { id: string; name: string; grade: string | null }[];
}
