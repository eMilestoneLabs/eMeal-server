import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';
import { Public } from '../../../common/decorators/public.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../../common/decorators/current-user.decorator';
import { EventsService } from '../services/events.service';
import { CreateEventDto } from '../dto/create-event.dto';
import { UpdateEventDto } from '../dto/update-event.dto';
import { CreateMealTypeDto, UpdateMealTypeDto } from '../dto/create-meal-type.dto';
import { CreatePartyDto, UpdatePartyDto, UpdatePersonDto } from '../dto/create-party.dto';
import { QueryEventsDto } from '../dto/query-events.dto';

/**
 * EventsController — 16 endpoints for Phase B5 event system.
 *
 * Route order critical: specific routes (join, meal-types, parties, stats) before /:id
 * Global JwtAuthGuard applies via APP_GUARD in app.module.ts.
 * SECURITY: organizationId always from JWT (@CurrentUser) — never from body.
 *
 * FIX: Replaced req.user as any → @CurrentUser() user: JwtPayload throughout.
 *      JWT payload field is `sub`, not `userId`. user.userId was always undefined,
 *      causing event adminId to be stored as null and auth checks to silently pass.
 *
 * Endpoints:
 *   GET    /api/v1/events/join/:token         — @Public: resolve event by QR join token
 *   POST   /api/v1/events
 *   GET    /api/v1/events
 *   GET    /api/v1/events/:id/stats
 *   GET    /api/v1/events/:id
 *   PATCH  /api/v1/events/:id
 *   DELETE /api/v1/events/:id
 *   POST   /api/v1/events/:id/meal-types
 *   PATCH  /api/v1/events/:id/meal-types/:mealTypeId
 *   DELETE /api/v1/events/:id/meal-types/:mealTypeId
 *   POST   /api/v1/events/:id/parties
 *   GET    /api/v1/events/:id/parties
 *   PATCH  /api/v1/events/:id/parties/:partyId
 *   DELETE /api/v1/events/:id/parties/:partyId
 *   PATCH  /api/v1/events/:id/persons/:personId         — update name / meal preference
 *   PATCH  /api/v1/events/:id/persons/:personId/presence — update isPresent
 */
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  // ── PUBLIC: RESOLVE EVENT BY QR JOIN TOKEN ────────────────────────────────
  // Must be declared BEFORE /:id routes — otherwise NestJS treats "join" as :id param.

  /**
   * GET /api/v1/events/join/:token
   *
   * Resolves an event by its join token (scanned from QR code).
   * @Public — unauthenticated event guests call this before creating their session.
   * Returns event details + active meal types so guests can select meals on join.
   */
  @Get('join/:token')
  @Public()
  async getEventByJoinToken(@Param('token') token: string) {
    return this.eventsService.getEventByJoinToken(token);
  }

  // ── EVENTS ────────────────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createEvent(
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Body() dto: CreateEventDto,
  ) {
    return this.eventsService.createEvent(
      user.sub,              // FIX: was user.userId (undefined) — JWT payload uses `sub`
      'Unknown',             // adminName: serializer fetches real name via DB JOIN
      user.organizationId!,
      user.role,
      dto,
      req.headers['x-request-id'] as string,
    );
  }

  @Get()
  async getEvents(
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryEventsDto,
  ) {
    return this.eventsService.getEvents(
      user.sub,              // FIX: was user.userId (undefined)
      user.organizationId!,
      user.role,
      query,
    );
  }

  @Get(':id/stats')
  async getEventStats(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.eventsService.getEventStats(id, user.organizationId!);
  }

  @Get(':id')
  async getEventById(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.eventsService.getEventById(id, user.organizationId!, user.role);
  }

  @Patch(':id')
  async updateEvent(
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateEventDto,
  ) {
    return this.eventsService.updateEvent(
      id,
      user.organizationId!,
      user.sub,              // FIX: was user.userId (undefined)
      user.role,
      dto,
      req.headers['x-request-id'] as string,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteEvent(
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    await this.eventsService.deleteEvent(
      id,
      user.organizationId!,
      user.sub,              // FIX: was user.userId (undefined)
      user.role,
      req.headers['x-request-id'] as string,
    );
  }

  // ── MEAL TYPES ────────────────────────────────────────────────────────────

  @Post(':id/meal-types')
  @HttpCode(HttpStatus.CREATED)
  async createMealType(
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: CreateMealTypeDto,
  ) {
    return this.eventsService.createMealType(
      id,
      user.organizationId!,
      user.sub,              // FIX: was user.userId (undefined)
      user.role,
      dto,
      req.headers['x-request-id'] as string,
    );
  }

  @Patch(':id/meal-types/:mealTypeId')
  async updateMealType(
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Param('id') id: string,
    @Param('mealTypeId') mealTypeId: string,
    @Body() dto: UpdateMealTypeDto,
  ) {
    return this.eventsService.updateMealType(
      id,
      mealTypeId,
      user.organizationId!,
      user.sub,              // FIX: was user.userId (undefined)
      user.role,
      dto,
      req.headers['x-request-id'] as string,
    );
  }

  @Delete(':id/meal-types/:mealTypeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMealType(
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Param('id') id: string,
    @Param('mealTypeId') mealTypeId: string,
  ) {
    await this.eventsService.deleteMealType(
      id,
      mealTypeId,
      user.organizationId!,
      user.sub,              // FIX: was user.userId (undefined)
      user.role,
      req.headers['x-request-id'] as string,
    );
  }

  // ── GUEST PARTIES ─────────────────────────────────────────────────────────

  @Post(':id/parties')
  @HttpCode(HttpStatus.CREATED)
  async createParty(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CreatePartyDto,
  ) {
    return this.eventsService.createParty(id, user.organizationId!, dto);
  }

  @Get(':id/parties')
  async getParties(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.eventsService.getParties(id, user.organizationId!, user.role, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Patch(':id/parties/:partyId')
  async updateParty(
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Param('id') id: string,
    @Param('partyId') partyId: string,
    @Body() dto: UpdatePartyDto,
  ) {
    return this.eventsService.updateParty(
      id,
      partyId,
      user.organizationId!,
      user.sub,              // FIX: was user.userId (undefined)
      user.role,
      dto,
      req.headers['x-request-id'] as string,
    );
  }

  @Delete(':id/parties/:partyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteParty(
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Param('id') id: string,
    @Param('partyId') partyId: string,
  ) {
    await this.eventsService.deleteParty(
      id,
      partyId,
      user.organizationId!,
      user.sub,              // FIX: was user.userId (undefined)
      user.role,
      req.headers['x-request-id'] as string,
    );
  }

  // ── GUEST PERSONS ─────────────────────────────────────────────────────────

  /**
   * PATCH /api/v1/events/:id/persons/:personId
   *
   * Updates a guest person's display name and/or meal preference.
   * Used by the primary guest (Rahul) to rename Guest-2, Guest-3, etc.
   */
  @Patch(':id/persons/:personId')
  async updatePerson(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('personId') personId: string,
    @Body() dto: UpdatePersonDto,
  ) {
    return this.eventsService.updatePersonDetails(
      id,
      personId,
      user.organizationId!,
      dto,
    );
  }

  /**
   * PATCH /api/v1/events/:id/persons/:personId/presence
   *
   * Marks a guest person as present/absent.
   * Called by event admin or the guest themselves when attending a meal session.
   */
  @Patch(':id/persons/:personId/presence')
  async updatePersonPresence(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('personId') personId: string,
    @Body() body: { isPresent: boolean; selectedMealTypeId?: string },
  ) {
    return this.eventsService.updatePersonPresence(
      id,
      personId,
      user.organizationId!,
      body,
    );
  }
}
