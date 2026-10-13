// Operator request templates only: no Artifacts, Git, authentication or model calls.
import {bookingPolicy} from './booking-policy.mjs';
import {starterFiles,planCorpus,studyConfig,safeID,hash} from './booking-campaign-plan.mjs';
export function bootstrapPlan(plan,template){
  const corpus=planCorpus(plan);
  safeID(template);
  const initial=bookingPolicy('initial_build');
  const policy={version:'booking-incomplete-bootstrap-v1',suite:initial.suite,environment:initial.environment,
    required_checks:['bootstrap-build'],build:{setup:[],checks:[{name:'bootstrap-build',argv:['node','build.mjs'],timeout_seconds:10}],
      app:initial.build.app}};
  return {version:1,executed:false,agent_evidence:false,publication_authorized:false,
    template,source_digest:hash(starterFiles()),template_requirement:'Private operator Artifacts template must contain the exact exported incomplete starter, not the completed reference control.',
    credential_handling:'Bootstrap Git capability remains private in memory; it must not enter logs, URL arguments, settings or output evidence.',
    template_creation:{method:'POST',path:'/api/bootstrap',body:{name:template},
      followup:'Operator pushes starter-workspace.json as main using returned private capability, verifies Git HEAD and revokes capability. This plan performs none of these actions.'},
    provisions:plan.chains.map(chain=>({method:'POST',path:'/api/admin/campaign/provision',
      body:{username:plan.username,repo_id:chain.repo_id,template,policy,context_study:studyConfig(plan,chain),
        context_seed:{intent_id:'intent:booking-study',statement:'Owner-seeded synthetic event-booking maintenance constraints; no agent or owner acceptance evidence.',
          records:corpus.map(record=>({...record,intent_id:'intent:booking-study',links:[]}))}},
      required_readback:{owner:plan.username,repo_id:chain.repo_id,source_digest:plan.source_digest},
      required_controlled_setup:{context_study:studyConfig(plan,chain),owner_asserted_corpus:corpus,
        intent_authority:'Dedicated owner-seeded synthetic maintenance intent; never agent-generated or accepted product evidence'}})),
    setup_gaps:['The bounded provision helper must pass context_seed and context_study to atomic owner init; generic admin configure_context_study is never used.',
      'Server campaign_budget capability and signed start route must be installed before any model calls.',
      'Enable a separate exact $12/$2 operator approval only after the private template and protected oracle/runtime gate are verified.'],
    bootstrap_policy_limit:'Build-only incomplete seed receipt is not independent product acceptance and authorizes no public campaign. Stage checks replace it before model execution.'};
}
