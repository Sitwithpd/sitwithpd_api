import 'dotenv/config';
import { indexAllKnowledge } from '../src/services/chat/knowledgeIndex.service';

indexAllKnowledge()
  .then((stats) => {
    console.log('Chat knowledge reindex complete:', stats);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Chat knowledge reindex failed:', err);
    process.exit(1);
  });
