import type { AgeCategory, DogSize, DogStatus, Gender } from '@dogadopt/contracts';

/** A row of the dogs table, as the data contract names it. */
export interface DogRow {
  id: string;
  rescue_id: string;
  external_id: string | null;
  name: string;
  status: DogStatus;
  status_notes: string | null;
  age: AgeCategory;
  birth_year: number | null;
  birth_month: number | null;
  birth_day: number | null;
  size: DogSize;
  gender: Gender;
  good_with_kids: number | null;
  good_with_dogs: number | null;
  good_with_cats: number | null;
  image_url: string | null;
  profile_url: string | null;
  description: string | null;
  rescue_since_date: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface RescueRow {
  id: string;
  name: string;
  type: 'Full' | 'Provisional';
  region: string;
  website: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  postcode: string | null;
  charity_number: string | null;
  contact_notes: string | null;
  latitude: number | null;
  longitude: number | null;
  created_at: string;
  updated_at: string;
}

/** One dog_breeds row. Exactly one of breedName / unresolvedName is set. */
export interface DogBreed {
  displayOrder: number;
  breedName: string | null;
  unresolvedName: string | null;
}

export interface DogWithBreeds extends DogRow {
  breeds: DogBreed[];
}
