// Импорты без расширений и через алиас tsconfig — как в приложении.
import { lead } from '@schemas/lead';
import { defineRelay } from '../../../index';
import { crm } from './src/channels';

export default defineRelay({
  channels: { crm },
  events: { lead: { name: 'Заявка', schema: lead, send: { crm: true } } },
});
