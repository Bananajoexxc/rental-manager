import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { findBestMatch, getInventoryItemNames } from '../utils/item-matcher';
import { DELIVERY_SPECS, getDeliverySpec } from '../data/delivery-specs';
import axios from 'axios';

export interface QuoteResult {
  vehicle: string;
  vehicle_display: string;
  distance_km: number;
  zone: string;
  price_min: number;
  price_max: number;
  items: { name: string; size_score: number; weight_kg: number; is_heavy_large: boolean }[];
  notes: string[];
  courier_explanation: string;
}

/** Max delivery radius in km (London only) */
const MAX_DELIVERY_KM = 30;

@Injectable()
export class DeliveryService implements OnModuleInit {
  private readonly logger = new Logger(DeliveryService.name);

  // Trafalgar Square coordinates
  private readonly ORIGIN_LAT = 51.508;
  private readonly ORIGIN_LNG = -0.1281;

  /**
   * Pricing table: motorcycle-to-car increase kept within 35-45%.
   * Van pricing remains unchanged.
   */
  private readonly pricing: Record<string, Record<string, { min: number; max: number }>> = {
    motorcycle: {
      core:    { min: 15, max: 20 },
      central: { min: 20, max: 27 },
      inner:   { min: 28, max: 38 },
      mid:     { min: 35, max: 48 },
      outer:   { min: 42, max: 55 },
      greater: { min: 50, max: 68 },
    },
    small_car: {
      core:    { min: 21, max: 27 },
      central: { min: 27, max: 37 },
      inner:   { min: 38, max: 52 },
      mid:     { min: 48, max: 65 },
      outer:   { min: 57, max: 75 },
      greater: { min: 68, max: 93 },
    },
    large_van: {
      core:    { min: 45, max: 65 },
      central: { min: 55, max: 75 },
      inner:   { min: 70, max: 95 },
      mid:     { min: 80, max: 105 },
      outer:   { min: 90, max: 115 },
      greater: { min: 105, max: 140 },
    },
  };

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    await this.seedItemSpecs();
    this.validatePricingConsistency();
  }

  /**
   * Upsert item specs from DELIVERY_SPECS data file.
   * Uses upsert so updates apply on restart without requiring DB reset.
   */
  async seedItemSpecs() {
    this.logger.log('Syncing item specifications from delivery-specs data...');
    let created = 0;
    let updated = 0;

    for (const spec of DELIVERY_SPECS) {
      const existing = await this.prisma.item_spec.findFirst({
        where: { item_name: spec.item_name },
      });

      if (existing) {
        await this.prisma.item_spec.update({
          where: { id: existing.id },
          data: {
            weight_kg: spec.weight_kg,
            length_cm: spec.packed_length_cm,
            width_cm: spec.packed_width_cm,
            height_cm: spec.packed_height_cm,
            size_score: spec.size_score,
            category: spec.category,
            notes: spec.courier_note,
          },
        });
        updated++;
      } else {
        await this.prisma.item_spec.create({
          data: {
            item_name: spec.item_name,
            weight_kg: spec.weight_kg,
            length_cm: spec.packed_length_cm,
            width_cm: spec.packed_width_cm,
            height_cm: spec.packed_height_cm,
            size_score: spec.size_score,
            category: spec.category,
            notes: spec.courier_note,
          },
        });
        created++;
      }
    }

    this.logger.log(`Item specs synced: ${created} created, ${updated} updated (${DELIVERY_SPECS.length} total)`);
  }

  /**
   * Validate that motorcycle-to-car price increase is within 35-45% for all zones.
   */
  private validatePricingConsistency(): void {
    const zones = ['core', 'central', 'inner', 'mid', 'outer', 'greater'];
    for (const zone of zones) {
      const moto = this.pricing.motorcycle[zone];
      const car = this.pricing.small_car[zone];
      const minIncrease = ((car.min - moto.min) / moto.min) * 100;
      const maxIncrease = ((car.max - moto.max) / moto.max) * 100;
      if (minIncrease < 35 || minIncrease > 45 || maxIncrease < 35 || maxIncrease > 45) {
        this.logger.warn(
          `Pricing consistency warning [${zone}]: moto->car min=${minIncrease.toFixed(1)}%, max=${maxIncrease.toFixed(1)}% (target: 35-45%)`,
        );
      }
    }
    this.logger.log('Delivery pricing consistency validated');
  }

  async getDistanceFromTrafalgarSquare(postcode: string): Promise<{ distance_km: number; zone: string } | null> {
    try {
      const resp = await axios.get(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
      if (resp.data.status !== 200) return null;

      const { latitude, longitude } = resp.data.result;
      const distance = this.haversine(this.ORIGIN_LAT, this.ORIGIN_LNG, latitude, longitude);
      const zone = this.getZone(distance);

      return { distance_km: Math.round(distance * 10) / 10, zone };
    } catch (error) {
      this.logger.warn(`Postcode lookup failed for ${postcode}: ${error.message}`);
      return null;
    }
  }

  private haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private getZone(km: number): string {
    if (km <= 3) return 'Central Core (0-3km)';
    if (km <= 5) return 'Central London (3-5km)';
    if (km <= 10) return 'Inner London (5-10km)';
    if (km <= 15) return 'Mid London (10-15km)';
    if (km <= 20) return 'Outer London (15-20km)';
    if (km <= 30) return 'Greater London (20-30km)';
    return 'Beyond 30km (outside delivery area)';
  }

  private getZoneKey(km: number): string {
    if (km <= 3) return 'core';
    if (km <= 5) return 'central';
    if (km <= 10) return 'inner';
    if (km <= 15) return 'mid';
    if (km <= 20) return 'outer';
    return 'greater';
  }

  async determineVehicle(
    itemNames: string[],
  ): Promise<{
    vehicle: string;
    vehicle_display: string;
    items: { name: string; size_score: number; weight_kg: number; is_heavy_large: boolean }[];
    courier_explanation: string;
  }> {
    const itemSpecs: { name: string; size_score: number; weight_kg: number; is_heavy_large: boolean }[] = [];

    for (const name of itemNames) {
      const matched = findBestMatch(name, getInventoryItemNames());
      const deliverySpec = matched ? getDeliverySpec(matched) : null;
      const dbSpec = matched
        ? await this.prisma.item_spec.findFirst({ where: { item_name: matched } })
        : null;

      itemSpecs.push({
        name: matched || name,
        size_score: deliverySpec?.size_score || dbSpec?.size_score || 2,
        weight_kg: deliverySpec?.weight_kg || dbSpec?.weight_kg || 1.0,
        is_heavy_large: deliverySpec?.is_heavy_large || false,
      });
    }

    const totalScore = itemSpecs.reduce((sum, i) => sum + i.size_score, 0);
    const maxScore = Math.max(...itemSpecs.map((i) => i.size_score));
    const totalWeight = itemSpecs.reduce((sum, i) => sum + i.weight_kg, 0);
    const itemCount = itemSpecs.length;
    const heavyLargeItems = itemSpecs.filter((i) => i.is_heavy_large);
    const heavyNames = heavyLargeItems.map((i) => i.name).join(', ');

    // DJ controller + speakers = mandatory large van
    const hasDJ = itemSpecs.some((i) => i.name.toLowerCase().includes('dj') && i.name.toLowerCase().includes('controller'));
    const hasSpeaker = itemSpecs.some((i) => i.name.toLowerCase().includes('speaker'));
    if (hasDJ && hasSpeaker) {
      return {
        vehicle: 'large_van',
        vehicle_display: 'Large van',
        items: itemSpecs,
        courier_explanation: 'The DJ controller and speakers require a large van for safe transport.',
      };
    }

    // 3+ items with score >= 4 = large van
    const largeItems = itemSpecs.filter((i) => i.size_score >= 4);
    if (largeItems.length >= 3) {
      return {
        vehicle: 'large_van',
        vehicle_display: 'Large van',
        items: itemSpecs,
        courier_explanation: `Multiple heavy/large items (${largeItems.map((i) => i.name).join(', ')}) require a large van.`,
      };
    }

    // Motorcycle: totalScore <= 3, maxScore <= 2, totalWeight <= 4kg, itemCount <= 2
    if (totalScore <= 3 && maxScore <= 2 && totalWeight <= 4.0 && itemCount <= 2) {
      return {
        vehicle: 'motorcycle',
        vehicle_display: 'Motorcycle courier',
        items: itemSpecs,
        courier_explanation: 'Your items are compact and light enough for a motorcycle courier.',
      };
    }

    // Small car (default)
    let explanation = 'A small car courier is needed for these items.';
    if (heavyLargeItems.length > 0) {
      explanation = `Due to the size/weight of ${heavyNames}, a car courier is needed instead of a motorcycle.`;
    } else if (itemCount > 2) {
      explanation = `With ${itemCount} items totalling ${totalWeight.toFixed(1)}kg, a car courier is needed.`;
    }

    return {
      vehicle: 'small_car',
      vehicle_display: 'Small car courier',
      items: itemSpecs,
      courier_explanation: explanation,
    };
  }

  async calculateQuote(postcode: string, itemNames: string[]): Promise<QuoteResult | null> {
    const location = await this.getDistanceFromTrafalgarSquare(postcode);
    if (!location) return null;

    // Enforce 30km maximum - London only
    if (location.distance_km > MAX_DELIVERY_KM) {
      return {
        vehicle: 'none',
        vehicle_display: 'N/A',
        distance_km: location.distance_km,
        zone: 'Beyond 30km (outside delivery area)',
        price_min: 0,
        price_max: 0,
        items: [],
        notes: [
          `We only deliver within London (max ${MAX_DELIVERY_KM}km from Central London).`,
          `Your location is ${location.distance_km}km away.`,
          `We suggest picking up from our Trafalgar Square location instead.`,
        ],
        courier_explanation: 'Outside delivery area.',
      };
    }

    const { vehicle, vehicle_display, items, courier_explanation } = await this.determineVehicle(itemNames);
    const zoneKey = this.getZoneKey(location.distance_km);
    const vehiclePricing = this.pricing[vehicle]?.[zoneKey] || this.pricing.small_car[zoneKey];

    const notes: string[] = [];
    if (vehicle === 'large_van') {
      notes.push('Large van required due to item size/combination');
    }
    if (vehicle === 'motorcycle') {
      notes.push('Motorcycle courier suitable for these compact items');
    }
    if (vehicle === 'small_car' && items.some((i) => i.is_heavy_large)) {
      notes.push('Car courier needed due to heavy/large items');
    }
    notes.push('Round-trip approx 1.8x one-way price');
    notes.push('Rush/priority delivery available at additional surcharge');
    notes.push('Addison Lee courier - no exact time guaranteed');
    notes.push('Estimates accurate within ~15% - actual price confirmed by courier');

    return {
      vehicle,
      vehicle_display,
      distance_km: location.distance_km,
      zone: location.zone,
      price_min: vehiclePricing.min,
      price_max: vehiclePricing.max,
      items,
      notes,
      courier_explanation,
    };
  }

  /**
   * Recalculate a delivery quote when items are added to an order.
   * Returns the old and new quotes plus explanation of what changed.
   */
  async recalculateQuote(
    postcode: string,
    previousItems: string[],
    newItems: string[],
  ): Promise<{
    oldQuote: QuoteResult;
    newQuote: QuoteResult;
    vehicleChanged: boolean;
    priceChanged: boolean;
    explanation: string;
  } | null> {
    const oldQuote = await this.calculateQuote(postcode, previousItems);
    const allItems = [...previousItems, ...newItems];
    const newQuote = await this.calculateQuote(postcode, allItems);

    if (!oldQuote || !newQuote) return null;

    const vehicleChanged = oldQuote.vehicle !== newQuote.vehicle;
    const priceChanged = oldQuote.price_min !== newQuote.price_min || oldQuote.price_max !== newQuote.price_max;

    let explanation = '';
    if (vehicleChanged) {
      explanation = `Adding ${newItems.join(', ')} changed the courier from ${oldQuote.vehicle_display} to ${newQuote.vehicle_display}. `;
    }
    if (priceChanged) {
      explanation += `Delivery estimate updated from £${oldQuote.price_min}-${oldQuote.price_max} to £${newQuote.price_min}-${newQuote.price_max}.`;
    }
    if (!vehicleChanged && !priceChanged) {
      explanation = 'No change to delivery quote after adding items.';
    }

    return { oldQuote, newQuote, vehicleChanged, priceChanged, explanation };
  }
}
