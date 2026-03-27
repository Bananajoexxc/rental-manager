export interface PickupLocation {
  address: string;
  mapsLink: string | null;
  shortName: string;
}

const LOCATIONS: Record<string, PickupLocation> = {
  dbcinema: {
    address: 'Statue of James II, 11 Trafalgar Square',
    mapsLink: 'https://share.google/G28UkWpFMDB2BDVWi',
    shortName: 'Trafalgar Square',
  },
  leo: {
    address: '5 Pall Mall East',
    mapsLink: null,
    shortName: 'Pall Mall East',
  },
};

export function getPickupLocation(account: string | null | undefined): PickupLocation {
  return LOCATIONS[(account || '').toLowerCase()] || LOCATIONS.dbcinema;
}
