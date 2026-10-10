import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { emitCaseSchema, emitRequirementsSchema } from './requirements-registry'

const dir = join(process.cwd(), 'docs/req')
writeFileSync(join(dir, 'req-schema.json'), emitRequirementsSchema())
writeFileSync(join(dir, 'case-schema.json'), emitCaseSchema())
process.stdout.write(`wrote ${join(dir, 'req-schema.json')} and case-schema.json\n`)
