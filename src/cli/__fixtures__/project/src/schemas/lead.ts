import { z } from 'zod';
import { phone } from '../../../../../index';

export const lead = z.object({
  name: z.string().min(1),
  phone: phone(),
  password: z.string().refine((value) => value.length > 8),
});
