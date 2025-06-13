import time

from fastapi import Depends

from system.backend.app.models.domain.error import Error
from system.backend.app.models.schemas.code_base_search_schema import (
    CodeBaseSearchQueryRequest,
)
from system.backend.app.repositories.error_repo import ErrorRepo
from system.backend.app.services.search_tools.embedding_service import (
    EmbeddingService,
)
from system.backend.app.services.search_tools.pinecone_service import (
    PineconeService,
)
from system.backend.app.services.search_tools.re_ranking_service import (
    RerankerService,
)


class CodeBaseSearchUsecase:
    def __init__(
        self,
        embedding_service: EmbeddingService = Depends(EmbeddingService),
        pinecone_service: PineconeService = Depends(PineconeService),
        reranker_service: RerankerService = Depends(RerankerService),
        error_repo: ErrorRepo = Depends(ErrorRepo),
    ):
        self.embedding_service = embedding_service
        self.pinecone_service = pinecone_service
        self.reranker_service = reranker_service
        self.embedding_model = "voyage-code-3"
        self.reranker_model = "rerank-2"
        self.similarity_metric = "dotproduct"
        self.dimension = 1024
        self.query_input_type = "query"
        self.top_k = 5  # Number of results to retrieve from vector DB
        self.error_repo = error_repo

    async def perform_rag(
        self, query: str, hashed_workspace_path: str, git_branch: str
    ):
        # Step 1: Generate embeddings for the query
        query_embedding = (
            await self.embedding_service.voyageai_dense_embeddings(
                self.embedding_model,
                dimension=self.dimension,
                inputs=[query],
                input_type=self.query_input_type,
            )
        )
        query_embedding = query_embedding[0]
        # List existing indexes
        list_result = await self.pinecone_service.list_pinecone_indexes()
        indexes = list_result.get("indexes", [])
        for index in indexes:
            if index.get("name") == hashed_workspace_path:
                index_host = index.get("host")
                break
        print(f" Using the index host: {index_host} for Query")

        vector_search_results = await self.pinecone_service.pinecone_query(
            index_host=index_host,
            top_k=self.top_k,
            vector=query_embedding,
            include_metadata=True,
            namespace=git_branch,
        )

        if not vector_search_results or not vector_search_results.get(
            "matches"
        ):
            return []

        # Step 3: Extract metadata from results
        doc_metadata = []
        for match in vector_search_results.get("matches", []):
            doc_metadata.append(
                {
                    "obfuscated_path": match.get("metadata", {}).get(
                        "obfuscated_path", "unknown"
                    ),
                    "score": match.get("score", 0),
                    "start_line": match.get("metadata", {}).get(
                        "start_line", "unknown"
                    ),
                    "end_line": match.get("metadata", {}).get(
                        "end_line", "unknown"
                    ),
                }
            )

        if not doc_metadata:
            await self.error_repo.insert_error(
                Error(
                    tool_name="code_base_search",
                    error_message="No valid documents found in vector search results",
                )
            )
            return []

        return doc_metadata

    async def process_query(self, request: CodeBaseSearchQueryRequest):
        start_time = time.time()
        query = request.query
        hashed_workspace_path = request.hashed_workspace_path
        git_branch = request.git_branch

        retrieved_docs = await self.perform_rag(
            query, hashed_workspace_path, git_branch
        )

        return retrieved_docs
