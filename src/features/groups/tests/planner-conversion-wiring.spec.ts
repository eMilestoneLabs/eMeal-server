import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { GroupsModule } from '../groups.module';
import { GroupsService } from '../groups.service';
import { GroupsRepository } from '../repositories/groups.repository';
import { MembersRepository } from '../repositories/members.repository';
import { PlannerModeConversionService } from '../../meals/services/planner-mode-conversion.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { UsersRepository } from '../../users/repositories/users.repository';

/**
 * Live-Test-15 ISSUE-1 — DI WIRING GUARD.
 *
 * `PlannerModeConversionService` is injected into `GroupsService` with
 * `@Optional() @Inject(Token)`. That pair is mandatory here: the `| null`
 * union erases `design:paramtypes`, so WITHOUT the explicit token Nest
 * silently injects `null` and the ENTIRE Weekly ⇆ Day-Wise conversion becomes
 * dead code — no error, no failing unit test, no compile error. The feature
 * would simply never run in production.
 *
 * It is also declared as a LOCAL provider of GroupsModule on purpose:
 * MealsModule already imports GroupsModule, so importing MealsModule back
 * would make the graph circular.
 *
 * Both facts are asserted here. The provider graph is declared explicitly
 * (leaf infrastructure stubbed) rather than by importing the real module tree,
 * because that tree instantiates socket/queue providers which never settle in
 * a unit-test process.
 */
describe('planner mode conversion — DI wiring', () => {
  it('GroupsModule DECLARES PlannerModeConversionService as a provider', () => {
    const providers: unknown[] =
      Reflect.getMetadata('providers', GroupsModule) ?? [];
    expect(providers).toContain(PlannerModeConversionService);
  });

  it('GroupsService actually RECEIVES the instance (not a silent null)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        GroupsService,
        PlannerModeConversionService,
        { provide: PrismaService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: GroupsRepository, useValue: {} },
        { provide: MembersRepository, useValue: {} },
        { provide: UsersRepository, useValue: {} },
      ],
    }).compile();

    const svc = moduleRef.get(GroupsService);
    expect((svc as any).plannerModeConversion).toBeInstanceOf(
      PlannerModeConversionService,
    );
    await moduleRef.close();
  });
});
