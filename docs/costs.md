# Geochalk v1 traffic cost estimates

Back-of-the-envelope USD/month estimates, researched 2026-11-13, for the deployed us-west-2 backend and mostly North American viewers. These are estimates of the new deployment, not a measured AWS invoice. Old retained stacks and data are additional.

## Traffic model

Assume each daily active user (DAU) spends 20 minutes/day in one visible, live room, for 30 days/month. The client polls every five seconds: 240 room reads/user/day, or **7,200 reads per DAU/month**. Hidden tabs and history mode pause polling. Initial loads, room changes, smart zoom, retries and moderation add work.

Assume about 1 KiB per stored post, 100–256 KiB returned per read (all surviving posts), one post per DAU/day, and a 512 MiB Lambda averaging 100 ms per request. The low end reads rooms with about 100 posts; the high end reads full 256-slot rooms. Include a small allowance for logs and base infrastructure; exclude paid Cognito MAUs, substantial accumulated storage, taxes, domain registration and legacy-stack costs. Do not subtract shared free tiers or introductory credits, making small-traffic estimates conservative.

| Daily active users | Room polls/month | Average concurrent viewers | Estimated monthly cost |
| ------------------ | ---------------: | -------------------------: | ---------------------: |
| 100                |          720,000 |                        1.4 |                $20–$40 |
| 1,000              |      7.2 million |                         14 |              $110–$270 |
| 10,000             |       72 million |                        139 |          $1,100–$2,700 |
| 100,000            |      720 million |                      1,389 |        $11,000–$27,000 |

The last row requires capacity/design changes; it is a cost extrapolation, not supported throughput. The ranges describe room-size assumptions, not worst-case bounds. Larger posts, long Lambda durations, accumulated moderation records or unusually heavy viewing can exceed them. Halving viewing time or doubling the polling interval approximately halves polling-related costs.

## Calculation and prices

A strongly consistent DynamoDB Query bills the aggregate bytes read, rounded to 4 KiB per page. A 100-post room at 1 KiB/post consumes about 25 read units; a full room consumes about 64, plus moderation queries and any page-boundary overhead. Application code loads all posts and moderation markers and returns all surviving posts, up to 256. Legacy physical records and moderation markers can add query cost beyond this steady-state model. [DynamoDB read accounting](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/read-write-operations.html).

Planning rates are $0.125/million read units and $0.625/million write units for DynamoDB Standard on-demand, with storage/PITR separate. Thus one million polls cost approximately $3.25 in room/moderation reads for the small-room case or $8.13 for full rooms with few moderation markers. [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/).

HTTP API Gateway costs about $1/million calls initially, with volume discounts. Lambda adds about $1.03/million calls at 512 MiB and 100 ms, before shared free allowances ($0.20/million requests plus $0.0000166667/GB-second). Actual Lambda duration needs measurement under full-room load. [API Gateway pricing](https://aws.amazon.com/api-gateway/pricing/), [Lambda pricing](https://aws.amazon.com/lambda/pricing/).

Budget roughly $1/million HTTPS requests plus $0.085/GB for North American CloudFront delivery before free allowances and volume discounts. At 100–256 KiB per response, delivery adds roughly $8.70–$22.28/million polls. AWS origin-to-CloudFront transfer is free, so do not double-count that leg. CloudFront's pay-as-you-go allowances include 1 TB and 10 million requests monthly, shared across eligible account usage. This model does not assume those allowances are available. [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/), [CloudFront FAQ](https://aws.amazon.com/cloudfront/faqs/).

Together, this is roughly **$15–$35 per million room polls**, plus small fixed costs and the exclusions above. At 7,200 polls per DAU/month, this is about **$0.11–$0.25 per DAU/month**. The table rounds generously. Dashboards, alarms, hosted zones, logs and deployment artifacts add a modest baseline; shared free allowances can reduce it. [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/), [Route 53 pricing](https://aws.amazon.com/route53/pricing/).

## Biggest drivers and thresholds

1. **Repeated full-room reads dominate busy rooms.** Full rooms cost about 2.6 times as much to query and return as 100-post rooms. Returning every post increases delivery costs relative to the earlier 50-post responses; bandwidth can now dominate. Smart zoom can read nine rooms. Moderation marker queries grow beyond the 256-post bound and projection does not reduce their billed read bytes.
2. **Viewing time drives polling, Lambda/API requests and bandwidth.** One active viewer generates 720 polls/hour. Doubling average stored post size roughly doubles database read costs; larger responses also increase delivery cost. Longer Lambda runtimes add compute cost.
3. **Cognito can become a separate large bill.** The deployed pool was verified as Essentials. Guest sessions bypass Cognito. Direct/social signed-in users get a shared 10,000 MAU free allowance; above it Essentials is $0.015/MAU. With the allowance available, 100,000 registered MAUs add about $1,350/month; one million add $14,850/month. MAU is not DAU. [Cognito pricing](https://aws.amazon.com/cognito/pricing/).
4. **Posting is relatively cheap at this read-heavy mix.** Nine room copies plus one archived original no larger than 1 KiB cost about $6.25 per million posts in writes, before admission counters, observations, retries and larger-item rounding. At one post/DAU/day, 100,000 DAU create three million posts/month. The append-only archive grows with every post, even after room deletion. At 1 KiB/post, one million archived posts add roughly 1 GB; table storage plus PITR costs roughly $0.45/GB-month before free allowances. Three million posts/month add roughly 3 GB/month of permanent archive growth, plus room copies, controls and retained predecessor data.
5. **The first capacity cliff precedes the largest cost rows.** The deployed API throttle is 100 requests/second with a 200 burst. Polling alone uses this at roughly **500 simultaneous visible viewers**, leaving no headroom for other calls. At 20 minutes/day this corresponds to about 36,000 DAU if traffic is perfectly flat; real daily peaks reach it sooner. Lambda is capped at 50 concurrent executions, so higher latency can create an earlier limit. A popular global or broad-prefix room can encounter DynamoDB hot-partition pressure before aggregate service limits.

## Highest-value cost work

Measure consumed read units and Lambda duration for sparse/full rooms, then prioritize shared short-lived caching of public room reads, slower/adaptive polling, or a push-based update design. A ten-second poll interval approximately halves polling costs. Any cache must respect moderation visibility and freshness requirements. Read only the data needed for a page if the storage model evolves; merely adding an HTTP limit to the current in-memory sorting does not do that. Consider Cognito Lite if future account volume justifies it and its feature set is sufficient. No pricing-tier or caching changes were made as part of the rename.

The 256-slot/archive revision reduces full-room database read units by roughly 75%, but returns up to 256 posts instead of 50. These estimates are updated for that behavior and unchanged planning rates. Archive storage is excluded from the table and grows over time rather than resetting monthly.
