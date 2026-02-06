import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface DspyStatus {
  healthy: boolean;
  status: string;
  lastOptimized: string | null;
  trainingExamples: number;
  tokenSavingsPct: number;
  optimizedModules: Record<string, any>;
}

export interface DspyOptimizationResult {
  success: boolean;
  moduleType: string;
  trainingExamples: number;
  validationQuality: number;
  estimatedTokenSavingsPct: number;
  meetsTarget: boolean;
  error?: string;
}

@Injectable()
export class DspyService {
  private readonly logger = new Logger(DspyService.name);
  private readonly baseUrl: string;
  private readonly enabled: boolean;

  constructor(private configService: ConfigService) {
    const port = this.configService.get<string>('DSPY_PORT') || '5000';
    this.baseUrl = `http://localhost:${port}`;
    this.enabled = this.configService.get<string>('DSPY_ENABLED') === 'true';
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async getHealth(): Promise<DspyStatus> {
    if (!this.enabled) {
      return {
        healthy: false,
        status: 'disabled',
        lastOptimized: null,
        trainingExamples: 0,
        tokenSavingsPct: 0,
        optimizedModules: {},
      };
    }

    try {
      const response = await axios.get(`${this.baseUrl}/health`, { timeout: 5000 });
      const data = response.data;

      return {
        healthy: data.status === 'healthy',
        status: data.dspy_status || 'unknown',
        lastOptimized: data.last_optimized || null,
        trainingExamples: data.training_examples || 0,
        tokenSavingsPct: data.token_savings_pct || 0,
        optimizedModules: {},
      };
    } catch (error) {
      this.logger.warn(`DSPy service unreachable: ${error.message}`);
      return {
        healthy: false,
        status: 'unreachable',
        lastOptimized: null,
        trainingExamples: 0,
        tokenSavingsPct: 0,
        optimizedModules: {},
      };
    }
  }

  async getStatus(): Promise<any> {
    if (!this.enabled) {
      return { success: false, error: 'DSPy is disabled' };
    }

    try {
      const response = await axios.get(`${this.baseUrl}/status`, { timeout: 5000 });
      return response.data;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async runOptimization(
    moduleType: 'rental' | 'pricing' | 'delivery' = 'rental',
    maxExamples = 100,
    targetQuality = 0.85,
  ): Promise<DspyOptimizationResult> {
    if (!this.enabled) {
      return {
        success: false,
        moduleType,
        trainingExamples: 0,
        validationQuality: 0,
        estimatedTokenSavingsPct: 0,
        meetsTarget: false,
        error: 'DSPy is disabled',
      };
    }

    try {
      this.logger.log(`Starting DSPy optimization for module: ${moduleType}`);

      const response = await axios.post(
        `${this.baseUrl}/optimize`,
        {
          module_type: moduleType,
          max_examples: maxExamples,
          target_quality: targetQuality,
        },
        { timeout: 300000 }, // 5 minute timeout for optimization
      );

      const data = response.data;
      this.logger.log(
        `DSPy optimization complete: quality=${data.validation_quality}, savings=${data.estimated_token_savings_pct}%`,
      );

      return {
        success: data.success,
        moduleType: data.module_type,
        trainingExamples: data.training_examples,
        validationQuality: data.validation_quality,
        estimatedTokenSavingsPct: data.estimated_token_savings_pct,
        meetsTarget: data.meets_target,
      };
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message;
      this.logger.error(`DSPy optimization failed: ${errorMsg}`);

      return {
        success: false,
        moduleType,
        trainingExamples: 0,
        validationQuality: 0,
        estimatedTokenSavingsPct: 0,
        meetsTarget: false,
        error: errorMsg,
      };
    }
  }

  async optimizePrompt(componentName: string, currentPrompt: string, targetQuality = 0.85): Promise<any> {
    if (!this.enabled) {
      return { success: false, error: 'DSPy is disabled' };
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/optimize-prompt`,
        {
          component_name: componentName,
          current_prompt: currentPrompt,
          target_quality: targetQuality,
        },
        { timeout: 120000 },
      );

      return response.data;
    } catch (error) {
      return { success: false, error: error.response?.data?.error || error.message };
    }
  }

  async generateResponse(
    moduleType: 'rental' | 'pricing' | 'delivery',
    renterMessage: string,
    context: string,
    rules: string,
  ): Promise<any> {
    if (!this.enabled) {
      return { success: false, error: 'DSPy is disabled' };
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/generate`,
        {
          module_type: moduleType,
          renter_message: renterMessage,
          context,
          rules,
        },
        { timeout: 30000 },
      );

      return response.data;
    } catch (error) {
      return { success: false, error: error.response?.data?.error || error.message };
    }
  }

  async analyzePrompts(): Promise<any> {
    if (!this.enabled) {
      return { success: false, error: 'DSPy is disabled' };
    }

    try {
      const response = await axios.get(`${this.baseUrl}/analyze-prompts`, { timeout: 30000 });
      return response.data;
    } catch (error) {
      return { success: false, error: error.response?.data?.error || error.message };
    }
  }

  async getTrainingData(limit = 100): Promise<any> {
    if (!this.enabled) {
      return { success: false, error: 'DSPy is disabled' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/export-training-data?limit=${limit}`,
        { timeout: 15000 },
      );
      return response.data;
    } catch (error) {
      return { success: false, error: error.response?.data?.error || error.message };
    }
  }

  async getNegativeExamples(limit = 50): Promise<any> {
    if (!this.enabled) {
      return { success: false, error: 'DSPy is disabled' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/negative-examples?limit=${limit}`,
        { timeout: 15000 },
      );
      return response.data;
    } catch (error) {
      return { success: false, error: error.response?.data?.error || error.message };
    }
  }
}
