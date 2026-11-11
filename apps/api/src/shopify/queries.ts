// Alle Felder wurden gegen das Admin-GraphQL-Schema geprüft (siehe docs/PHASE1_ANALYSE.md).

const ORDER_FIELDS = /* GraphQL */ `
  id
  name
  number
  createdAt
  updatedAt
  cancelledAt
  test
  email
  customerLocale
  sourceName
  customerAcceptsMarketing
  displayFinancialStatus
  displayFulfillmentStatus
  returnStatus
  totalPriceSet { shopMoney { amount currencyCode } }
  totalRefundedSet { shopMoney { amount currencyCode } }
  customer {
    id
    firstName
    lastName
    defaultEmailAddress { emailAddress marketingState }
  }
  shippingLine { title carrierIdentifier }
  lineItems(first: 50) {
    nodes { id title sku quantity product { id } originalUnitPriceSet { shopMoney { amount } } }
  }
  fulfillments(first: 20) {
    id
    status
    displayStatus
    createdAt
    inTransitAt
    deliveredAt
    estimatedDeliveryAt
    trackingInfo(first: 5) { company number url }
    events(first: 50, sortKey: HAPPENED_AT) { nodes { id status happenedAt message } }
  }
  customerJourneySummary {
    ready
    firstVisit { source referrerUrl landingPage utmParameters { source medium campaign } }
    lastVisit { source referrerUrl landingPage utmParameters { source medium campaign } }
  }
`;

export const ORDERS_PAGE = /* GraphQL */ `
  query OrdersPage($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ORDER_FIELDS} }
    }
  }
`;

export const ORDER_BY_ID = /* GraphQL */ `
  query OrderById($id: ID!) {
    order(id: $id) { ${ORDER_FIELDS} }
  }
`;

export const SHOP_INFO = /* GraphQL */ `
  query ShopInfo { shop { id name myshopifyDomain ianaTimezone currencyCode } }
`;

export const WEBHOOK_SUBSCRIPTIONS = /* GraphQL */ `
  query Webhooks { webhookSubscriptions(first: 50) { nodes { id topic uri } } }
`;

export const WEBHOOK_CREATE = /* GraphQL */ `
  mutation WebhookCreate($topic: WebhookSubscriptionTopic!, $uri: String!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) {
      webhookSubscription { id topic }
      userErrors { field message }
    }
  }
`;

/** Benötigte Webhooks (Topics als GraphQL-Enum) */
export const WEBHOOK_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "FULFILLMENTS_CREATE",
  "FULFILLMENTS_UPDATE",
  "FULFILLMENT_EVENTS_CREATE",
  "REFUNDS_CREATE",
  "APP_UNINSTALLED",
] as const;

export interface Money {
  shopMoney: { amount: string; currencyCode?: string };
}

export interface Visit {
  source?: string | null;
  referrerUrl?: string | null;
  landingPage?: string | null;
  utmParameters?: { source?: string | null; medium?: string | null; campaign?: string | null } | null;
}

export interface ShopifyOrder {
  id: string;
  name: string;
  number: number;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  test: boolean;
  email: string | null;
  customerLocale: string | null;
  sourceName: string | null;
  customerAcceptsMarketing: boolean;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  returnStatus: string | null;
  totalPriceSet: Money;
  totalRefundedSet: Money;
  customer: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    defaultEmailAddress: { emailAddress: string; marketingState: string } | null;
  } | null;
  shippingLine: { title: string | null; carrierIdentifier: string | null } | null;
  lineItems: { nodes: { id: string; title: string; sku: string | null; quantity: number; product: { id: string } | null; originalUnitPriceSet: Money }[] };
  fulfillments: {
    id: string;
    status: string;
    displayStatus: string | null;
    createdAt: string;
    inTransitAt: string | null;
    deliveredAt: string | null;
    estimatedDeliveryAt: string | null;
    trackingInfo: { company: string | null; number: string | null; url: string | null }[];
    events: { nodes: { id: string; status: string; happenedAt: string; message: string | null }[] };
  }[];
  customerJourneySummary: { ready: boolean; firstVisit: Visit | null; lastVisit: Visit | null } | null;
}
