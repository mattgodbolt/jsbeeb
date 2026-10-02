import { createDynamoStore } from "./dynamo-store.js";
import { createHandler } from "./handler.js";

export const handler = createHandler({ store: createDynamoStore(process.env.TABLE) });
