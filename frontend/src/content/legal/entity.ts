// The facts the Terms and Privacy Policy state about the company, as the owner gave them.
// The legal pages name them as `{{field}}`; the site tests fail while any field is empty, so
// a page never ships with a gap or a placeholder in it. There is no postal address: legal
// and copyright notices go by email to legal@yonedarepo.com.
export const LEGAL_ENTITY = {
  /** The company's full registered name. */
  legalName: 'Yoneda Labs, Inc.',
  /** Its kind, as registered. */
  entityType: 'corporation',
  /** Where it is registered: a state or country. */
  formation: 'Delaware',
  /** The law that governs the Terms: a state or country. */
  governingLaw: 'the State of Delaware, USA',
  /** Where disputes are heard: the courts, or an arbitration body and seat. */
  disputeVenue: 'the state and federal courts located in Delaware',
  /** The youngest age at which a person may use the service. */
  minimumAge: '16',
  /** The date both pages were last changed (YYYY-MM-DD). */
  lastUpdated: '2026-10-30',
};

export type LegalField = keyof typeof LEGAL_ENTITY;
