'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function loadTeamConfiguration() {
  const configPath = path.join(__dirname, '..', 'commands', 'configure-team.yaml');
  const parsed = yaml.load(fs.readFileSync(configPath, 'utf8'));
  return parsed.team_configuration;
}

function inferBuilderAgents(domains = [], teamConfiguration = loadTeamConfiguration()) {
  const defaults = teamConfiguration.default_agents || {};
  const builders = [];

  const directBuilderDomains = ['backend', 'frontend', 'infrastructure', 'devops'];
  for (const domain of domains) {
    if (directBuilderDomains.includes(domain) && defaults[domain]) {
      builders.push(defaults[domain]);
    }
  }

  if (domains.includes('database') || domains.includes('security')) {
    if (defaults.backend) builders.push(defaults.backend);
  }

  if (builders.length === 0) {
    builders.push(defaults.backend || 'backend-developer');
  }

  return unique(builders);
}

function resolveDefaultTeamRoles(input = {}) {
  const teamConfiguration = loadTeamConfiguration();
  const defaults = teamConfiguration.default_agents || {};
  const domains = input.domains || [];
  const builderAgents = inferBuilderAgents(domains, teamConfiguration);

  return {
    lead: {
      agents: [defaults.lead || 'tech-lead-orchestrator'],
      owns: ['planning', 'escalation', 'skip-decisions'],
    },
    builder: {
      agents: builderAgents,
      owns: ['implementation'],
    },
    architect: {
      agents: ['architect'],
      owns: ['task-design', 'architecture-drift-detection'],
    },
    documentation: {
      agents: [defaults.documentation || 'documentation-specialist'],
      owns: ['pr-boundary-doc-maintenance'],
    },
    reviewer: {
      agents: [defaults.reviewer || 'code-reviewer'],
      owns: ['code-review'],
    },
    qa: {
      agents: [defaults.qa || defaults.qa_fallback || 'qa-orchestrator'],
      owns: ['quality-assurance'],
    },
    advisor: {
      agents: ['advisor'],
      owns: ['shortcut-detection', 'solution-quality', 'requirement-traceability'],
    },
    pm: {
      agents: ['product-management-orchestrator'],
      owns: ['requirement-clarification', 'scope-decisions', 'ambiguity-resolution'],
    },
  };
}

module.exports = {
  loadTeamConfiguration,
  resolveDefaultTeamRoles,
  inferBuilderAgents,
};
