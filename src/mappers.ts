// Row -> contract shape. The contract is camelCase JSON with every property
// present (null where unknown); the generated response schemas are strict.
import { ageCategoryFromBirth, type Dog, type PageMeta, type Rescue } from '@dogadopt/contracts';
import type { DogListedWithBreeds, RescueWithCount } from './repo.js';

const toBool = (v: number | null): boolean | null => (v === null ? null : v === 1);

export function toDog(row: DogListedWithBreeds, now: Date, distanceKm?: number): Dog {
  const dog: Dog = {
    id: row.id,
    name: row.name,
    status: row.status,
    age: row.birth_year !== null ? ageCategoryFromBirth(row.birth_year, row.birth_month, row.birth_day, now) : row.age,
    size: row.size,
    gender: row.gender,
    breeds: row.breeds.filter((b) => b.breedName !== null).map((b) => b.breedName as string),
    unresolvedBreeds: row.breeds.filter((b) => b.unresolvedName !== null).map((b) => b.unresolvedName as string),
    goodWithKids: toBool(row.good_with_kids),
    goodWithDogs: toBool(row.good_with_dogs),
    goodWithCats: toBool(row.good_with_cats),
    imageUrl: row.image_url,
    profileUrl: row.profile_url,
    description: row.description,
    birthYear: row.birth_year,
    birthMonth: row.birth_month,
    birthDay: row.birth_day,
    rescueSinceDate: row.rescue_since_date,
    statusNotes: row.status_notes,
    rescue: { id: row.rescue_id, name: row.rescue_name, region: row.rescue_region, website: row.rescue_website },
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (distanceKm !== undefined) dog.distanceKm = distanceKm;
  return dog;
}

export function toRescue(row: RescueWithCount): Rescue {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    region: row.region,
    website: row.website,
    phone: row.phone,
    email: row.email,
    address: row.address,
    postcode: row.postcode,
    charityNumber: row.charity_number,
    contactNotes: row.contact_notes,
    latitude: row.latitude,
    longitude: row.longitude,
    dogCount: row.dog_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function pageMeta(page: number, pageSize: number, total: number): PageMeta {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}
