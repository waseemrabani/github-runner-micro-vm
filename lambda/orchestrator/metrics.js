'use strict';

// CloudWatch Embedded Metric Format (EMF): a structured stdout line that
// CloudWatch Logs turns into metrics on ingestion. No SDK call and no extra
// IAM - Lambda already ships stdout to the function's log group.
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
//
// Kept identical in lambda/orchestrator and lambda/worker (each is packaged
// as its own zip).

const NAMESPACE = process.env.METRICS_NAMESPACE ?? 'GitHubRunnerMicroVMs';

/**
 * Dimension sets for one metric: the full set, each dimension on its own
 * (when there is more than one), and none - so dashboards can slice by e.g.
 * Profile while alarms watch the fleet-wide total without knowing which
 * profiles exist.
 * @param {string[]} keys
 * @returns {string[][]}
 */
function dimensionSets(keys) {
  if (keys.length === 0) return [[]];
  const singles = keys.length > 1 ? keys.map((k) => [k]) : [];
  return [keys, ...singles, []];
}

/**
 * @param {string} name
 * @param {number} value
 * @param {'Count'|'Milliseconds'} unit
 * @param {Record<string, string>} [dimensions] values must be non-empty strings
 * @param {Record<string, unknown>} [properties] extra fields, searchable in Logs Insights but not dimensions
 */
function putMetric(name, value, unit, dimensions = {}, properties = {}) {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: NAMESPACE,
            Dimensions: dimensionSets(Object.keys(dimensions)),
            Metrics: [{ Name: name, Unit: unit }],
          },
        ],
      },
      ...properties,
      ...dimensions,
      [name]: value,
    })
  );
}

module.exports = { putMetric, dimensionSets };
