import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

/**
 * The store on the table the Lambda runs against. The SDK comes with the Lambda runtime, not with the site.
 *
 * @param {string} tableName
 * @returns {import("./memory-store.js").RendezvousStore}
 */
export function createDynamoStore(tableName) {
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    return {
        async get(room, entry) {
            const { Item } = await client.send(new GetCommand({ TableName: tableName, Key: { room, entry } }));
            return Item;
        },
        async put(item, { unlessLiveAt } = {}) {
            const condition =
                unlessLiveAt === undefined
                    ? {}
                    : {
                          ConditionExpression: "attribute_not_exists(#entry) OR #expires <= :now",
                          ExpressionAttributeNames: { "#entry": "entry", "#expires": "expires" },
                          ExpressionAttributeValues: { ":now": unlessLiveAt },
                      };
            try {
                await client.send(new PutCommand({ TableName: tableName, Item: item, ...condition }));
                return true;
            } catch (error) {
                if (error.name === "ConditionalCheckFailedException") return false;
                throw error;
            }
        },
        async query(room) {
            const items = [];
            let ExclusiveStartKey;
            do {
                const page = await client.send(
                    new QueryCommand({
                        TableName: tableName,
                        KeyConditionExpression: "#room = :room",
                        ExpressionAttributeNames: { "#room": "room" },
                        ExpressionAttributeValues: { ":room": room },
                        ExclusiveStartKey,
                    }),
                );
                items.push(...page.Items);
                ExclusiveStartKey = page.LastEvaluatedKey;
            } while (ExclusiveStartKey);
            return items;
        },
        async delete(room, entry) {
            await client.send(new DeleteCommand({ TableName: tableName, Key: { room, entry } }));
        },
    };
}
