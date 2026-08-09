/**
 * DI WIRING GUARD — the two @Optional injections P-01 depends on.
 *
 * `@Optional() @Inject(Token) dep: T | null` is required here because the
 * `| null` union erases `design:paramtypes`, and because dozens of existing
 * unit tests construct these services by hand. The cost of that pattern is a
 * SILENT failure mode: if the provider is ever unwired, Nest injects `null`,
 * nothing throws, nothing fails to compile, and the feature simply never runs.
 *
 * Concretely:
 *   • PreferencesService → SchedulesService — `publishPreferenceResolver()`
 *     returns undefined, the published snapshot is never frozen, and the WHOLE
 *     P-01 published-isolation fix becomes dead code in production.
 *   • SchedulesRepository → GroupsService — auto-draft trigger #3 (Global Meal
 *     Preference) silently stops flipping the planner to draft.
 *
 * Both are asserted here. The provider graph is declared explicitly with leaf
 * infrastructure stubbed (same approach as planner-conversion-wiring.spec)
 * because importing the real module tree instantiates socket/queue providers
 * that never settle in a unit-test process.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { MealsModule } from '../meals.module';
import { GroupsModule } from '../../groups/groups.module';
import { SchedulesService } from '../schedules.service';
import { SchedulesRepository } from '../repositories/schedules.repository';
import { MealsRepository } from '../repositories/meals.repository';
import { GroupsService } from '../../groups/groups.service';
import { GroupsRepository } from '../../groups/repositories/groups.repository';
import { MembersRepository } from '../../groups/repositories/members.repository';
import { UsersRepository } from '../../users/repositories/users.repository';
import { PreferencesService } from '../../preferences/preferences.service';
import { PreferenceGroupsRepository } from '../../preferences/repositories/preference-groups.repository';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';

describe('P-01 publish-freeze — DI wiring', () => {
  it('MealsModule IMPORTS PreferencesModule (the resolver source)', () => {
    const imports: unknown[] = Reflect.getMetadata('imports', MealsModule) ?? [];
    const names = imports.map((m: any) => m?.name);
    expect(names).toContain('PreferencesModule');
  });

  it('GroupsModule DECLARES SchedulesRepository (auto-draft trigger #3)', () => {
    const providers: unknown[] =
      Reflect.getMetadata('providers', GroupsModule) ?? [];
    expect(providers).toContain(SchedulesRepository);
  });

  it('SchedulesService RECEIVES PreferencesService — not a silent null', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        SchedulesService,
        PreferencesService,
        { provide: SchedulesRepository, useValue: {} },
        { provide: MealsRepository, useValue: {} },
        { provide: GroupsRepository, useValue: {} },
        { provide: PreferenceGroupsRepository, useValue: {} },
        { provide: PrismaService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    const svc = moduleRef.get(SchedulesService);
    expect((svc as any).preferences).toBeInstanceOf(PreferencesService);
    // …and the publish context it produces must carry BOTH members: the
    // batched resolver AND the canonical per-day narrower borrowed from
    // Module 36. A missing `narrowByDay` would mean the freeze re-implemented
    // the narrowing rule locally — the duplication this design removed.
    const ctx = (svc as any).publishPreferenceResolver('org_1');
    expect(typeof ctx.resolve).toBe('function');
    expect(typeof ctx.narrowByDay).toBe('function');
    await moduleRef.close();
  });

  it('GroupsService RECEIVES SchedulesRepository — not a silent null', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        GroupsService,
        SchedulesRepository,
        { provide: PrismaService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: GroupsRepository, useValue: {} },
        { provide: MembersRepository, useValue: {} },
        { provide: UsersRepository, useValue: {} },
      ],
    }).compile();

    const svc = moduleRef.get(GroupsService);
    expect((svc as any).schedulesRepo).toBeInstanceOf(SchedulesRepository);
    await moduleRef.close();
  });
});
