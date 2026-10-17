import { env } from '../../../../index';

export const crm = { type: 'webhook' as const, url: env('CRM_URL') };
