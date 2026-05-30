import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class JoinGroupDto {
  /**
   * The join code displayed on the group QR code.
   * Stored as joinToken in DB — exposed as joinCode in API.
   * Flutter sends: { "joinCode": "HTL3K8XZ" }
   *
   * Normalized to uppercase so manual entry "htl3k8xz" also works.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase().trim() : value))
  joinCode: string;
}
