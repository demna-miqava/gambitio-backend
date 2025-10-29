import type { FastifyInstance } from "fastify";
import { SettingsRepository } from "../repositories/settingsRepository.js";
import type { Settings, UpdateSettingsRequest } from "../models/Settings.js";

export class SettingsService {
  private settingsRepository: SettingsRepository;

  constructor(fastify: FastifyInstance) {
    this.settingsRepository = new SettingsRepository(fastify);
  }

  async getSettings(userId: number): Promise<Settings> {
    const settings = await this.settingsRepository.getSettings(userId);

    if (!settings) {
      // Create default settings if they don't exist
      return await this.settingsRepository.createDefaultSettings(userId);
    }

    return settings;
  }

  async updateSettings(
    userId: number,
    updates: UpdateSettingsRequest
  ): Promise<Settings> {
    // Ensure settings exist before updating
    await this.getSettings(userId);

    return await this.settingsRepository.updateSettings(userId, updates);
  }
}
