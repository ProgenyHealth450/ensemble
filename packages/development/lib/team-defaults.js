'use strict';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function inferBuilderAgents(domains = []) {
  const builders = [];

  if (domains.includes('backend') || domains.includes('database') || domains.includes('security')) {
    builders.push('backend-developer');
  }

  if (domains.includes('frontend')) {
    builders.push('frontend-developer');
  }

  if (domains.includes('infrastructure') || domains.includes('devops')) {
    builders.push('infrastructure-developer');
  }

  if (builders.length === 0) {
    builders.push('backend-developer');
  }

  return unique(builders);
}

function resolveDefaultTeamRoles(input = {}) {
  const domains = input.domains || [];
  const builderAgents = inferBuilderAgents(domains);

  return {
    lead: {
      agents: ['tech-lead-orchestrator'],
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
      agents: ['documentation-specialist'],
      owns: ['pr-boundary-doc-maintenance'],
    },
    reviewer: {
      agents: ['code-reviewer'],
      owns: ['code-review'],
    },
    qa: {
      agents: ['qa-orchestrator'],
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
  resolveDefaultTeamRoles,
  inferBuilderAgents,
};
