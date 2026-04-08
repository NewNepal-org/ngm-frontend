// ============================================================================
// PROTOTYPE DATA - Person Search Feature
// ============================================================================
// This file contains hardcoded person data extracted from case 080-CR-0158
// using Likhit (Jawafdehi MCP) for accurate Nepali text extraction.
//
// TODO: Replace with backend metadata when available
// Expected backend structure:
//   manuscript.metadata.persons = [
//     { name: "सुनिल पौडेल", name_english: "Sunil Poudel", role: "...", ... }
//   ]
//
// Migration path:
//   1. Backend adds "persons" array to manuscript metadata
//   2. Update IndexViewer.tsx to extract persons from metadata
//   3. Remove this file
// ============================================================================

export interface Person {
  id: string;
  name: string;
  nameEnglish?: string;
  role: string;
  cases: CaseInfo[];
}

export interface CaseInfo {
  caseId: string;
  caseNumber: string;
  title: string;
  amount: string;
  charges: string[];
  status: string;
  date: string;
  sources: string[];
}

// Sample data extracted from the case files using Likhit
export const personsData: Person[] = [
  {
    id: 'person-1',
    name: 'सुनिल पौडेल',
    nameEnglish: 'Sunil Poudel',
    role: 'पूर्व कार्यकारी निर्देशक, राष्ट्रिय सूचना प्रविधि केन्द्र तथा प्रबन्ध निर्देशक, नेपाल टेलिकम',
    cases: [
      {
        caseId: '080-CR-0158',
        caseNumber: '080-CR-0158',
        title: 'सुनिल पौडेलको २३ करोडको गैरकानुनी सम्पत्ति आर्जन',
        amount: 'रु. २३,७५,४६,३२४.५७',
        charges: [
          'गैरकानूनी सम्पत्ति आर्जन (भ्रष्टाचार निवारण ऐन, २०५९ को दफा २०)',
          'झुट्टा सम्पत्ति विवरण पेश (भ्रष्टाचार निवारण ऐन, २०५९ को दफा १६)',
          'विदेशी बैङ्कमा गैरकानूनी खाता र रकम जम्मा',
          'कमिशन लिने (स्वदेशी र विदेशी कम्पनीहरुसँग)',
          'टेण्डरमा मिलेमतो र योजनाबद्ध भ्रष्टाचार',
          'पदको दुरुपयोग (भ्रष्टाचार निवारण ऐन, २०५९ को दफा २४)'
        ],
        status: 'विशेष अदालत, काठमाडौंमा आरोपपत्र दायर (२०८१/०१/०९)',
        date: '२०८१/०१/०९',
        sources: [
          'CIAA Press Release (Likhit)',
          'BTV Business News',
          'Cabinet Decision',
          'Prasashan News'
        ]
      }
    ]
  },
  {
    id: 'person-2',
    name: 'अनिल पौडेल',
    nameEnglish: 'Anil Poudel',
    role: 'सहोदर दाजु (मध्यम व्यक्ति)',
    cases: [
      {
        caseId: '080-CR-0158',
        caseNumber: '080-CR-0158',
        title: 'सुनिल पौडेलको २३ करोडको गैरकानुनी सम्पत्ति आर्जन',
        amount: '-',
        charges: [
          'गैरकानूनी सम्पत्तिको लगानी/घरजग्गा खरिदमा सहयोग',
          'स्रोत नखुलेको सम्पत्तिबाट घरजग्गा खरिद'
        ],
        status: 'सम्पत्ति जफत प्रयोजनार्थ प्रतिवादी कायम (२०८१/०१/०९)',
        date: '२०८१/०१/०९',
        sources: [
          'CIAA Press Release (Likhit)',
          'BTV Business News'
        ]
      }
    ]
  },
  {
    id: 'person-3',
    name: 'दिपक पौडेल',
    nameEnglish: 'Dipak Poudel',
    role: 'सम्बन्धित व्यक्ति',
    cases: [
      {
        caseId: '080-CR-0158',
        caseNumber: '080-CR-0158',
        title: 'सुनिल पौडेलको २३ करोडको गैरकानुनी सम्पत्ति आर्जन',
        amount: '-',
        charges: [
          'सम्बन्धित व्यक्ति'
        ],
        status: 'अनुसन्धानमा',
        date: '२०८१/०१/०९',
        sources: [
          'Case Snapshot'
        ]
      }
    ]
  }
];

// Check if a text contains any person names
export function containsPersonName(text: string, nameQuery: string): boolean {
  if (!nameQuery.trim()) return true;
  
  const lowerText = text.toLowerCase();
  const lowerQuery = nameQuery.toLowerCase();
  
  // Check against all known persons
  for (const person of personsData) {
    const nepaliName = person.name.toLowerCase();
    const englishName = person.nameEnglish?.toLowerCase() || '';
    
    // Split names into parts for partial matching
    const nepaliParts = nepaliName.split(' ');
    const englishParts = englishName.split(' ');
    const queryParts = lowerQuery.split(' ').filter(part => part.length >= 3);
    
    // Track which query parts match this person's name
    const matchedQueryParts: string[] = [];
    
    // Check Nepali name
    if (nepaliName.includes(lowerQuery) || lowerQuery.includes(nepaliName)) {
      matchedQueryParts.push(...queryParts);
    }
    
    // Check English name
    if (englishName && (englishName.includes(lowerQuery) || lowerQuery.includes(englishName))) {
      matchedQueryParts.push(...queryParts);
    }
    
    // Check if query parts match person's name parts
    for (const queryPart of queryParts) {
      if (nepaliParts.some(part => part.includes(queryPart) || queryPart.includes(part))) {
        matchedQueryParts.push(queryPart);
      }
      if (englishParts.some(part => part.includes(queryPart) || queryPart.includes(part))) {
        matchedQueryParts.push(queryPart);
      }
    }
    
    // Only proceed if query actually matches this person
    if (matchedQueryParts.length === 0) {
      continue;
    }
    
    // Now check if the text contains the matched query parts (not all name parts)
    const textContainsMatchedParts = matchedQueryParts.some(part => lowerText.includes(part));
    
    if (textContainsMatchedParts) {
      return true;
    }
  }
  
  // No person match found
  return false;
}
