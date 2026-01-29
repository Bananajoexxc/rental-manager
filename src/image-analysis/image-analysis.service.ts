import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { LoggingService } from '../logging/logging.service';

export interface ExtractedItem {
  itemName: string;
  confidenceScore: number;
}

@Injectable()
export class ImageAnalysisService {
  private readonly logger = new Logger(ImageAnalysisService.name);
  private readonly apiKey: string;
  private readonly apiUrl = 'https://apps.abacus.ai/v1/chat/completions';

  constructor(private loggingService: LoggingService) {
    this.apiKey = process.env.ABACUSAI_API_KEY || '';
    if (!this.apiKey) {
      this.logger.warn('⚠️ ABACUSAI_API_KEY not set - image analysis will be disabled');
    }
  }

  async analyzeImage(imageUrl: string): Promise<ExtractedItem[]> {
    try {
      if (!this.apiKey) {
        this.logger.warn('Image analysis skipped - no API key');
        return [];
      }

      this.logger.log(`🔍 Analyzing image: ${imageUrl.substring(0, 50)}...`);

      const response = await axios.post(
        this.apiUrl,
        {
          model: 'gpt-4o',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Analyze this image and list all visible items, objects, furniture, equipment, or belongings. For each item, provide a confidence score (0-1) indicating how certain you are about its presence. Please respond in JSON format with an array of objects containing "itemName" and "confidenceScore" fields.',
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: imageUrl,
                  },
                },
              ],
            },
          ],
          response_format: { type: 'json_object' },
          stream: false,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
        },
      );

      const content = response.data.choices[0].message.content;
      const parsed = JSON.parse(content);

      // Handle different possible response formats
      let items: ExtractedItem[] = [];
      if (parsed.items) {
        items = parsed.items;
      } else if (Array.isArray(parsed)) {
        items = parsed;
      } else if (parsed.objects) {
        items = parsed.objects;
      }

      this.logger.log(`✅ Found ${items.length} items in image`);
      this.loggingService.info('Image analysis completed', { itemCount: items.length, imageUrl });

      return items;
    } catch (error) {
      this.logger.error('❌ Error analyzing image', error);
      this.loggingService.error('Image analysis failed', { error: error.message, imageUrl });
      return [];
    }
  }

  async analyzeImages(imageUrls: string[]): Promise<ExtractedItem[]> {
    const allItems: ExtractedItem[] = [];
    const itemMap = new Map<string, number>();

    for (const url of imageUrls) {
      const items = await this.analyzeImage(url);
      items.forEach((item) => {
        const existingScore = itemMap.get(item.itemName) || 0;
        itemMap.set(item.itemName, Math.max(existingScore, item.confidenceScore));
      });

      // Add small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Convert map back to array
    itemMap.forEach((confidenceScore, itemName) => {
      allItems.push({ itemName, confidenceScore });
    });

    return allItems;
  }

  parseDescriptionForItems(description: string): string[] {
    if (!description) return [];

    try {
      // Simple keyword extraction based on common rental items
      const commonItems = [
        'table', 'chair', 'bed', 'sofa', 'couch', 'desk', 'lamp', 'mirror', 'rug',
        'cabinet', 'shelf', 'wardrobe', 'dresser', 'nightstand', 'bookshelf',
        'tv', 'television', 'computer', 'laptop', 'monitor', 'keyboard', 'mouse',
        'phone', 'camera', 'speaker', 'headphones',
        'bicycle', 'bike', 'scooter', 'skateboard',
        'refrigerator', 'microwave', 'oven', 'stove', 'dishwasher', 'washing machine',
        'vacuum', 'iron', 'fan', 'heater', 'air conditioner',
        'plant', 'picture', 'painting', 'clock', 'vase', 'cushion', 'blanket', 'pillow',
        'drill', 'hammer', 'toolbox', 'ladder', 'tools',
        'grill', 'tent', 'sleeping bag', 'backpack', 'suitcase',
      ];

      const foundItems: string[] = [];
      const lowerDesc = description.toLowerCase();

      commonItems.forEach((item) => {
        if (lowerDesc.includes(item)) {
          foundItems.push(item);
        }
      });

      this.logger.log(`📝 Extracted ${foundItems.length} items from description`);
      return foundItems;
    } catch (error) {
      this.logger.error('Error parsing description', error);
      return [];
    }
  }
}
